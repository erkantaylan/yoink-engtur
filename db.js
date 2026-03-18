const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "data", "words.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'entr',
    translations TEXT NOT NULL,
    voice_urls TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    review_count INTEGER DEFAULT 0,
    UNIQUE(term, lang)
  )
`);

function saveWord(term, lang, result) {
  const translations = JSON.stringify(result.Results || []);
  const voiceUrls = JSON.stringify(result.VoiceURLs || []);

  db.prepare(`
    INSERT INTO words (term, lang, translations, voice_urls)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(term, lang) DO UPDATE SET
      translations = excluded.translations,
      voice_urls = excluded.voice_urls
  `).run(term, lang, translations, voiceUrls);
}

function getWords(lang, status) {
  let sql = "SELECT * FROM words WHERE 1=1";
  const params = [];
  if (lang) {
    sql += " AND lang = ?";
    params.push(lang);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC";
  return db.prepare(sql).all(...params);
}

function updateWordStatus(id, status) {
  db.prepare(`
    UPDATE words SET status = ?, reviewed_at = CURRENT_TIMESTAMP, review_count = review_count + 1
    WHERE id = ?
  `).run(status, id);
}

function deleteWord(id) {
  db.prepare("DELETE FROM words WHERE id = ?").run(id);
}

function getStats() {
  const total = db.prepare("SELECT COUNT(*) as count FROM words").get().count;
  const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM words GROUP BY status").all();
  const today = db.prepare("SELECT COUNT(*) as count FROM words WHERE date(created_at) = date('now')").get().count;
  return { total, today, byStatus };
}

module.exports = { saveWord, getWords, updateWordStatus, deleteWord, getStats };
