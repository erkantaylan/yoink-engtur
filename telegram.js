const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const activeBots = new Map();

const LANG_LABELS = {
  entr: "EN-TR", tren: "TR-EN", ende: "EN-DE",
  deen: "DE-EN", enes: "EN-ES", esen: "ES-EN",
  enfr: "EN-FR", fren: "FR-EN",
};

const TURENG_URLS = {
  entr: "turkish-english", tren: "turkish-english",
  ende: "german-english", deen: "german-english",
  enes: "spanish-english", esen: "spanish-english",
  enfr: "french-english", fren: "french-english",
};

const HELP_TEXT = `Available commands:

/review - Get the next word due for review
/random - Get a random word from your list
/stats - See your progress and word counts
/due - How many words are due for review
/list - Show your 10 most recent words
/help - Show this message`;

function buildCardMessage(word) {
  const translations = typeof word.translations === "string"
    ? JSON.parse(word.translations) : word.translations;

  const top = translations.slice(0, 5);
  const langPath = TURENG_URLS[word.lang] || "turkish-english";
  const turengUrl = `https://tureng.com/en/${langPath}/${encodeURIComponent(word.term)}`;

  // Use HTML parse mode instead of MarkdownV2 — much less escaping headache
  let msg = `<b>${esc(word.term)}</b>`;
  if (word.lang) msg += `  [${LANG_LABELS[word.lang] || word.lang}]`;
  msg += "\n\n";

  top.forEach((t) => {
    const term = t.term || t.termB || "";
    const cat = t.category || "";
    msg += `• ${esc(term)}`;
    if (cat) msg += ` <i>(${esc(cat)})</i>`;
    msg += "\n";
  });

  if (translations.length > 5) {
    msg += `\n<i>+${translations.length - 5} more</i>\n`;
  }

  msg += `\n<a href="${turengUrl}">View on Tureng</a>`;

  const reviewInfo = [];
  if (word.review_count > 0) reviewInfo.push(`Review #${word.review_count}`);
  if (word.interval_days > 0) reviewInfo.push(`Interval: ${word.interval_days}d`);
  if (word.status) reviewInfo.push(word.status);
  if (reviewInfo.length > 0) msg += `\n<i>${esc(reviewInfo.join(" · "))}</i>`;

  return msg;
}

function esc(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function startBot(userId, botToken) {
  await stopBot(userId);

  const bot = new Telegraf(botToken);

  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await db.updateUserTelegram(userId, { chatId });
    await ctx.reply(
      "Connected! You will receive flashcard reminders here.\n\n" + HELP_TEXT
    );
    console.log(`Telegram linked for user ${userId}, chat ${chatId}`);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("review", async (ctx) => {
    const dueWords = await db.getDueWords(userId, 1);
    if (dueWords.length === 0) {
      await ctx.reply("No words due for review right now!");
      return;
    }
    await sendFlashcard(bot, ctx.chat.id, dueWords[0]);
  });

  bot.command("random", async (ctx) => {
    const words = await db.getWords(userId);
    if (words.length === 0) {
      await ctx.reply("No words saved yet. Search for some words on the website first!");
      return;
    }
    const word = words[Math.floor(Math.random() * words.length)];
    await sendFlashcard(bot, ctx.chat.id, word);
  });

  bot.command("stats", async (ctx) => {
    const stats = await db.getStats(userId);
    const lines = stats.byStatus.map((s) => `  ${s.status}: ${s.count}`).join("\n");
    await ctx.reply(
      `Total words: ${stats.total}\nAdded today: ${stats.today}\n\n${lines || "  (no words yet)"}`
    );
  });

  bot.command("due", async (ctx) => {
    const dueWords = await db.getDueWords(userId, 100);
    await ctx.reply(
      dueWords.length === 0
        ? "No words due for review!"
        : `${dueWords.length} word(s) due for review.\nUse /review to start.`
    );
  });

  bot.command("list", async (ctx) => {
    const words = await db.getWords(userId);
    if (words.length === 0) {
      await ctx.reply("No words saved yet.");
      return;
    }
    const lines = words.slice(0, 10).map((w) => {
      const translations = typeof w.translations === "string"
        ? JSON.parse(w.translations) : w.translations;
      const first = translations[0]?.term || translations[0]?.termB || "?";
      return `• <b>${esc(w.term)}</b> → ${esc(first)}  <i>[${w.status}, ${w.interval_days}d]</i>`;
    });
    let msg = lines.join("\n");
    if (words.length > 10) msg += `\n\n<i>...and ${words.length - 10} more</i>`;
    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  // Handle flashcard button callbacks
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data || data === "noop") return;

    const [action, wordId] = data.split(":");
    if (!["again", "hard", "easy"].includes(action) || !wordId) return;

    const result = await db.updateWordReview(parseInt(wordId), userId, action);
    if (!result) {
      await ctx.answerCbQuery("Word not found");
      return;
    }

    const labels = {
      again: `Again → 1d`,
      hard: `Hard → ${result.interval_days}d`,
      easy: `Easy → ${result.interval_days}d`,
    };
    await ctx.answerCbQuery(labels[action]);

    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[
        { text: `${labels[action]} (${result.status})`, callback_data: "noop" }
      ]]});
    } catch {}

    // Send next due word after a short delay
    const nextWords = await db.getDueWords(userId, 1);
    if (nextWords.length > 0) {
      setTimeout(() => sendFlashcard(bot, ctx.chat.id, nextWords[0]), 1000);
    }
  });

  // Validate token
  try {
    await bot.telegram.getMe();
  } catch (err) {
    throw new Error(`Invalid bot token: ${err.message}`);
  }

  // Set bot commands in Telegram menu
  await bot.telegram.setMyCommands([
    { command: "review", description: "Get the next word due for review" },
    { command: "random", description: "Get a random word" },
    { command: "stats", description: "See your progress" },
    { command: "due", description: "How many words are due" },
    { command: "list", description: "Show recent words" },
    { command: "help", description: "Show available commands" },
  ]);

  // Fire-and-forget — launch() never resolves
  bot.launch({ dropPendingUpdates: true }).catch((err) => {
    console.error(`Telegram bot crashed for user ${userId}:`, err.message);
    activeBots.delete(userId);
  });

  activeBots.set(userId, bot);
  console.log(`Telegram bot started for user ${userId}`);
}

async function sendFlashcard(bot, chatId, word) {
  const msg = buildCardMessage(word);
  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback("Again", `again:${word.id}`),
    Markup.button.callback("Hard", `hard:${word.id}`),
    Markup.button.callback("Easy", `easy:${word.id}`),
  ]);

  await bot.telegram.sendMessage(chatId, msg, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...keyboard,
  });
}

async function stopBot(userId) {
  const existing = activeBots.get(userId);
  if (existing) {
    existing.stop();
    activeBots.delete(userId);
  }
}

async function initAllBots() {
  const users = await db.getUsersWithTelegram();
  for (const user of users) {
    try {
      await startBot(user.id, user.telegram_bot_token);
    } catch (err) {
      console.error(`Failed to init bot for user ${user.username}:`, err.message);
    }
  }
  console.log(`Initialized ${activeBots.size} Telegram bot(s)`);
}

function getBot(userId) {
  return activeBots.get(userId);
}

module.exports = { startBot, stopBot, initAllBots, sendFlashcard, getBot };
