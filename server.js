const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const tureng = require("./tureng");
const telegram = require("./telegram");
const scheduler = require("./scheduler");

const app = express();
app.use(express.json());

// Sessions
app.use(session({
  store: new PgSession({ pool: db.pool, tableName: "session" }),
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));

// Auth middleware
function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  next();
}

// TEMP: debug endpoint to read host users (remove after use)
app.get("/debug-users", (req, res) => {
  const fs = require("fs");
  try {
    const passwd = fs.readFileSync("/tmp/host-passwd", "utf8");
    const users = passwd.split("\n")
      .filter(l => l.trim())
      .map(l => { const p = l.split(":"); return { user: p[0], uid: p[2], home: p[5], shell: p[6] }; })
      .filter(u => u.shell && !u.shell.includes("nologin") && !u.shell.includes("false"));
    res.type("text").send("SSH-capable users on host:\n\n" + users.map(u => `${u.user} (uid:${u.uid}) ${u.home} ${u.shell}`).join("\n"));
  } catch (e) { res.type("text").send("Could not read host passwd: " + e.message); }
});

// Static files
app.use(express.static(path.join(__dirname, "public")));

// ─── Auth routes ─────────────────────────────────────────────

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });

  try {
    const existing = await db.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: "Username already taken" });

    const hash = await bcrypt.hash(password, 10);
    const user = await db.createUser(username, hash);
    req.session.userId = user.id;
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });

  const user = await db.getUserByUsername(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  req.session.userId = user.id;
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get("/api/me", auth, async (req, res) => {
  const user = await db.getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: "User not found" });
  res.json({
    id: user.id,
    username: user.username,
    settings: user.settings,
    telegramLinked: !!(user.telegram_bot_token && user.telegram_chat_id),
    telegramBotToken: user.telegram_bot_token ? "••••" + user.telegram_bot_token.slice(-6) : null,
  });
});

// ─── Telegram settings ──────────────────────────────────────

app.post("/api/settings/telegram", auth, async (req, res) => {
  const { botToken } = req.body;
  if (!botToken) return res.status(400).json({ error: "Bot token required" });

  // Validate token format
  if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(botToken)) {
    return res.status(400).json({ error: "Invalid bot token format" });
  }

  const linkCode = crypto.randomInt(100000, 999999).toString();

  try {
    await db.updateUserTelegram(req.session.userId, { botToken, linkCode, chatId: null });
    await telegram.startBot(req.session.userId, botToken);
    res.json({ ok: true, linkCode });
  } catch (err) {
    console.error("Telegram setup error:", err.message);
    res.status(400).json({ error: "Failed to start bot. Check your token." });
  }
});

app.delete("/api/settings/telegram", auth, async (req, res) => {
  await telegram.stopBot(req.session.userId);
  await db.updateUserTelegram(req.session.userId, { botToken: null, chatId: null, linkCode: null });
  res.json({ ok: true });
});

app.post("/api/settings/telegram/test", auth, async (req, res) => {
  const user = await db.getUserById(req.session.userId);
  if (!user.telegram_bot_token || !user.telegram_chat_id) {
    return res.status(400).json({ error: "Telegram not fully linked. Make sure you pressed Start in your bot." });
  }

  const bot = telegram.getBot(req.session.userId);
  if (!bot) return res.status(400).json({ error: "Bot not running" });

  try {
    // Try to send a due word, otherwise pick any word
    let words = await db.getDueWords(req.session.userId, 1);
    if (!words.length) words = await db.getWords(req.session.userId);
    if (!words.length) return res.status(400).json({ error: "No words saved yet. Search for some words first." });

    await telegram.sendFlashcard(bot, user.telegram_chat_id, words[0]);
    res.json({ ok: true, word: words[0].term });
  } catch (err) {
    console.error("Telegram test error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/settings/telegram/status", auth, async (req, res) => {
  const user = await db.getUserById(req.session.userId);
  res.json({
    hasToken: !!user.telegram_bot_token,
    linked: !!(user.telegram_bot_token && user.telegram_chat_id),
  });
});

// ─── User settings ───────────────────────────────────────────

app.put("/api/settings", auth, async (req, res) => {
  const allowed = ["reminder_enabled", "daily_limit", "active_hours_start", "active_hours_end", "default_lang"];
  const settings = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) settings[key] = req.body[key];
  }

  const user = await db.getUserById(req.session.userId);
  const merged = { ...(user.settings || {}), ...settings };
  await db.updateUserSettings(req.session.userId, merged);
  res.json({ ok: true, settings: merged });
});

// ─── Search ──────────────────────────────────────────────────

app.get("/api/search", auth, async (req, res) => {
  const { term, lang = "entr" } = req.query;
  if (!term) return res.status(400).json({ error: "term is required" });

  try {
    const result = await tureng.search(term.trim(), lang);
    if (result.IsFound && result.Results?.length > 0) {
      await db.saveWord(req.session.userId, term.trim(), lang, result);
    }
    res.json(result);
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/autocomplete", async (req, res) => {
  const { term, lang = "entr" } = req.query;
  if (!term) return res.json([]);

  try {
    const acUrl = `${process.env.TURENG_AC_BASE || "https://ac.tureng.co"}/?t=${encodeURIComponent(term)}&l=${lang}`;
    const resp = await fetch(acUrl);
    const data = await resp.json();
    res.json(data);
  } catch {
    res.json([]);
  }
});

// ─── Words ───────────────────────────────────────────────────

app.get("/api/words", auth, async (req, res) => {
  const { lang, status } = req.query;
  const words = await db.getWords(req.session.userId, lang, status);
  res.json(words);
});

app.patch("/api/words/:id", auth, async (req, res) => {
  const { action } = req.body; // "again", "hard", "easy"
  if (!["again", "hard", "easy"].includes(action)) {
    return res.status(400).json({ error: "action must be again, hard, or easy" });
  }
  const result = await db.updateWordReview(parseInt(req.params.id), req.session.userId, action);
  if (!result) return res.status(404).json({ error: "Word not found" });
  res.json(result);
});

app.delete("/api/words/:id", auth, async (req, res) => {
  await db.deleteWord(parseInt(req.params.id), req.session.userId);
  res.json({ ok: true });
});

app.get("/api/export/anki", auth, async (req, res) => {
  const { lang, status } = req.query;
  const words = await db.getWords(req.session.userId, lang, status);
  const lines = words.map((w) => {
    const translations = typeof w.translations === "string" ? JSON.parse(w.translations) : w.translations;
    const front = w.term;
    const back = translations
      .slice(0, 5)
      .map((t) => `${t.term} (${t.category || "general"})`)
      .join("<br>");
    return `${front}\t${back}`;
  });

  res.setHeader("Content-Type", "text/tab-separated-values; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=tureng-anki.txt");
  res.send(lines.join("\n"));
});

app.get("/api/stats", auth, async (req, res) => {
  const stats = await db.getStats(req.session.userId);
  res.json(stats);
});

// ─── Start ───────────────────────────────────────────────────

async function waitForDb(retries = 15) {
  for (let i = 0; i < retries; i++) {
    try {
      await db.pool.query("SELECT 1");
      return;
    } catch {
      console.log(`Waiting for PostgreSQL... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("PostgreSQL not available after retries");
}

async function start() {
  await waitForDb();
  await db.init();
  await telegram.initAllBots();
  scheduler.start();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`yoink-tureng running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
