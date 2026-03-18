const express = require("express");
const path = require("path");
const db = require("./db");
const tureng = require("./tureng");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Search tureng and save the word
app.get("/api/search", async (req, res) => {
  const { term, lang = "entr" } = req.query;
  if (!term) return res.status(400).json({ error: "term is required" });

  try {
    const result = await tureng.search(term.trim(), lang);
    if (result.IsFound && result.Results?.length > 0) {
      db.saveWord(term.trim(), lang, result);
    }
    res.json(result);
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Autocomplete (direct, no flaresolverr needed)
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

// Get saved words (card deck)
app.get("/api/words", (req, res) => {
  const { lang, status } = req.query;
  res.json(db.getWords(lang, status));
});

// Update word status (learned, reviewing, etc.)
app.patch("/api/words/:id", (req, res) => {
  const { status } = req.body;
  db.updateWordStatus(req.params.id, status);
  res.json({ ok: true });
});

// Delete a word
app.delete("/api/words/:id", (req, res) => {
  db.deleteWord(req.params.id);
  res.json({ ok: true });
});

// Export as Anki-compatible TSV
app.get("/api/export/anki", (req, res) => {
  const { lang, status } = req.query;
  const words = db.getWords(lang, status);
  const lines = words.map((w) => {
    const translations = JSON.parse(w.translations);
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

// Stats
app.get("/api/stats", (req, res) => {
  res.json(db.getStats());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`yoink-tureng running on http://localhost:${PORT}`);
});
