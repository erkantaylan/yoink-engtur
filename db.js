const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      telegram_bot_token TEXT,
      telegram_chat_id TEXT,
      telegram_link_code TEXT,
      settings JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS words (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'entr',
      translations JSONB NOT NULL,
      voice_urls JSONB DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      ease_factor REAL DEFAULT 2.5,
      interval_days INTEGER DEFAULT 0,
      next_review_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      review_count INTEGER DEFAULT 0,
      UNIQUE(user_id, term, lang)
    );

    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);
  `);
}

// Users
async function createUser(username, passwordHash) {
  const res = await pool.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
    [username, passwordHash]
  );
  return res.rows[0];
}

async function getUserByUsername(username) {
  const res = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  return res.rows[0];
}

async function getUserById(id) {
  const res = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return res.rows[0];
}

async function updateUserTelegram(userId, { botToken, chatId, linkCode }) {
  const sets = [];
  const vals = [];
  let i = 1;

  if (botToken !== undefined) { sets.push(`telegram_bot_token = $${i++}`); vals.push(botToken); }
  if (chatId !== undefined) { sets.push(`telegram_chat_id = $${i++}`); vals.push(chatId); }
  if (linkCode !== undefined) { sets.push(`telegram_link_code = $${i++}`); vals.push(linkCode); }

  if (sets.length === 0) return;
  vals.push(userId);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
}

async function updateUserSettings(userId, settings) {
  await pool.query("UPDATE users SET settings = $1 WHERE id = $2", [JSON.stringify(settings), userId]);
}

async function getUsersWithTelegram() {
  const res = await pool.query(
    "SELECT * FROM users WHERE telegram_bot_token IS NOT NULL AND telegram_chat_id IS NOT NULL"
  );
  return res.rows;
}

// Words
async function saveWord(userId, term, lang, result) {
  const translations = JSON.stringify(result.Results || []);
  const voiceUrls = JSON.stringify(result.VoiceURLs || []);

  await pool.query(`
    INSERT INTO words (user_id, term, lang, translations, voice_urls, next_review_at)
    VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 day')
    ON CONFLICT(user_id, term, lang) DO UPDATE SET
      translations = EXCLUDED.translations,
      voice_urls = EXCLUDED.voice_urls
  `, [userId, term, lang, translations, voiceUrls]);
}

async function getWords(userId, lang, status) {
  let sql = "SELECT * FROM words WHERE user_id = $1";
  const params = [userId];
  let i = 2;
  if (lang) { sql += ` AND lang = $${i++}`; params.push(lang); }
  if (status) { sql += ` AND status = $${i++}`; params.push(status); }
  sql += " ORDER BY created_at DESC";
  const res = await pool.query(sql, params);
  return res.rows;
}

async function getWordById(wordId, userId) {
  const res = await pool.query("SELECT * FROM words WHERE id = $1 AND user_id = $2", [wordId, userId]);
  return res.rows[0];
}

async function updateWordReview(wordId, userId, action) {
  const word = await getWordById(wordId, userId);
  if (!word) return null;

  let { ease_factor, interval_days } = word;

  if (action === "again") {
    interval_days = 1;
    ease_factor = Math.max(1.3, ease_factor - 0.2);
  } else if (action === "hard") {
    interval_days = Math.max(1, Math.round(interval_days * 1.2));
    ease_factor = Math.max(1.3, ease_factor - 0.1);
  } else if (action === "easy") {
    interval_days = interval_days === 0 ? 1 : Math.round(interval_days * ease_factor);
    ease_factor = Math.min(3.0, ease_factor + 0.1);
  }

  const status = action === "easy" && interval_days >= 21 ? "learned" : action === "again" ? "new" : "reviewing";

  await pool.query(`
    UPDATE words SET
      status = $1, ease_factor = $2, interval_days = $3,
      next_review_at = NOW() + make_interval(days => $3),
      reviewed_at = NOW(), review_count = review_count + 1
    WHERE id = $4 AND user_id = $5
  `, [status, ease_factor, interval_days, wordId, userId]);

  return { status, interval_days, ease_factor };
}

async function deleteWord(wordId, userId) {
  await pool.query("DELETE FROM words WHERE id = $1 AND user_id = $2", [wordId, userId]);
}

async function getStats(userId) {
  const total = (await pool.query("SELECT COUNT(*) FROM words WHERE user_id = $1", [userId])).rows[0].count;
  const today = (await pool.query(
    "SELECT COUNT(*) FROM words WHERE user_id = $1 AND created_at::date = CURRENT_DATE", [userId]
  )).rows[0].count;
  const byStatus = (await pool.query(
    "SELECT status, COUNT(*) as count FROM words WHERE user_id = $1 GROUP BY status", [userId]
  )).rows;
  return { total: +total, today: +today, byStatus };
}

async function getDueWords(userId, limit = 10) {
  const res = await pool.query(`
    SELECT * FROM words
    WHERE user_id = $1 AND next_review_at <= NOW() AND status != 'learned'
    ORDER BY next_review_at ASC LIMIT $2
  `, [userId, limit]);
  return res.rows;
}

module.exports = {
  pool, init,
  createUser, getUserByUsername, getUserById,
  updateUserTelegram, updateUserSettings, getUsersWithTelegram,
  saveWord, getWords, getWordById, updateWordReview, deleteWord, getStats, getDueWords,
};
