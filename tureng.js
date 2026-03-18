const { execSync } = require("child_process");
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191";

const LANG_URLS = {
  entr: "turkish-english",
  tren: "turkish-english",
  ende: "german-english",
  deen: "german-english",
  enes: "spanish-english",
  esen: "spanish-english",
  enfr: "french-english",
  fren: "french-english",
};

// Cached Cloudflare clearance
let cfCookieStr = null;
let cfUserAgent = null;
let cfExpiry = 0;
let solving = false;
let solvePromise = null;

async function solveCloudflare(url) {
  // Prevent concurrent solves
  if (solving) return solvePromise;
  solving = true;

  solvePromise = (async () => {
    console.log("Solving Cloudflare challenge...");
    const resp = await fetch(`${FLARESOLVERR_URL}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: "request.get",
        url,
        maxTimeout: 60000,
      }),
    });

    const data = await resp.json();
    if (data.status !== "ok") {
      throw new Error(`FlareSolverr error: ${data.message || "unknown"}`);
    }

    cfUserAgent = data.solution?.userAgent;
    cfCookieStr = (data.solution?.cookies || [])
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    cfExpiry = Date.now() + 25 * 60 * 1000;

    console.log("Cloudflare solved, cookies cached for ~25 min");
    solving = false;
    return data.solution?.response;
  })();

  try {
    return await solvePromise;
  } catch (err) {
    solving = false;
    throw err;
  }
}

function curlFetch(url) {
  try {
    const result = execSync(
      `curl -s -L --max-time 15 ` +
      `-H "User-Agent: ${cfUserAgent}" ` +
      `-H "Cookie: ${cfCookieStr}" ` +
      `-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" ` +
      `-H "Accept-Language: en-US,en;q=0.5" ` +
      `-o - -w "\\n%{http_code}" ` +
      `"${url}"`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    // Last line is the HTTP status code
    const lines = result.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop(), 10);
    const body = lines.join("\n");

    if (statusCode === 403 || statusCode === 503) {
      return null; // cookies expired
    }

    // Check if it's a Cloudflare challenge page
    if (body.includes("Just a moment...") || body.includes("challenge-platform")) {
      return null;
    }

    return body;
  } catch {
    return null;
  }
}

async function search(term, lang = "entr") {
  const langPath = LANG_URLS[lang] || "turkish-english";
  const url = `https://tureng.com/en/${langPath}/${encodeURIComponent(term)}`;

  let html = null;

  // Try curl with cached cookies first (fast path)
  if (cfCookieStr && Date.now() < cfExpiry) {
    html = curlFetch(url);
    if (html) {
      return parseResults(html, term);
    }
    console.log("Cached cookies rejected, re-solving...");
  }

  // Slow path: solve Cloudflare (also gets the result for the requested URL)
  html = await solveCloudflare(url);
  if (!html) throw new Error("Empty response");

  return parseResults(html, term);
}

function parseResults(html, searchTerm) {
  const notFound = html.includes("Maybe the correct one is") ||
    html.includes("couldn't be found") ||
    html.includes("is not found");

  if (notFound) {
    const suggestions = [];
    const sugRe = /<li[^>]*>\s*<a[^>]*>([^<]+)<\/a>\s*<\/li>/gi;
    let match;
    while ((match = sugRe.exec(html)) !== null) {
      const s = decodeHtmlEntities(match[1].trim());
      if (s && !suggestions.includes(s)) suggestions.push(s);
    }
    return { IsFound: false, Suggestions: suggestions.length > 0 ? suggestions : null, Results: [] };
  }

  const results = [];
  const voiceUrls = [];

  const voiceRe = /data-voice="([^"]+)"/gi;
  let vm;
  while ((vm = voiceRe.exec(html)) !== null) {
    voiceUrls.push(vm[1]);
  }

  const tableRe = /<tr[^>]*>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const category = stripHtml(m[2]).trim();
    const colA = stripHtml(m[3]).trim();
    const colB = stripHtml(m[4]).trim();

    if (!colA || !colB) continue;
    if (colA.toLowerCase() === "english" || colA.toLowerCase() === "turkish") continue;

    const typeMatchA = colA.match(/\{([^}]+)\}/);
    const typeMatchB = colB.match(/\{([^}]+)\}/);

    results.push({
      category,
      termA: typeMatchA ? colA.replace(/\{[^}]+\}/, "").trim() : colA,
      typeA: typeMatchA ? typeMatchA[1] : null,
      term: typeMatchB ? colB.replace(/\{[^}]+\}/, "").trim() : colB,
      termB: typeMatchB ? colB.replace(/\{[^}]+\}/, "").trim() : colB,
      typeB: typeMatchB ? typeMatchB[1] : null,
    });
  }

  if (results.length === 0) {
    const rowRe = /<tr[^>]*class="[^"]*searchResultsRow(?:Odd|Even)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(html)) !== null) {
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        cells.push(stripHtml(cm[1]).trim());
      }
      if (cells.length >= 4) {
        results.push({
          category: cells[1],
          termA: cells[2],
          typeA: null,
          term: cells[3],
          termB: cells[3],
          typeB: null,
        });
      }
    }
  }

  if (results.length === 0) {
    const anyRowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let ar;
    while ((ar = anyRowRe.exec(html)) !== null) {
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(ar[1])) !== null) {
        cells.push(stripHtml(cm[1]).trim());
      }
      if (cells.length >= 4 && /^\d+$/.test(cells[0]) && cells[2] && cells[3]) {
        results.push({
          category: cells[1],
          termA: cells[2],
          typeA: null,
          term: cells[3],
          termB: cells[3],
          typeB: null,
        });
      }
    }
  }

  return {
    IsFound: results.length > 0,
    Results: results,
    VoiceURLs: voiceUrls,
    Suggestions: null,
  };
}

function stripHtml(html) {
  return decodeHtmlEntities(
    html
      .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

module.exports = { search };
