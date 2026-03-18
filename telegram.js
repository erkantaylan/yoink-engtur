const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

// One bot instance per user, keyed by user ID
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

function buildCardMessage(word) {
  const translations = typeof word.translations === "string"
    ? JSON.parse(word.translations)
    : word.translations;

  const top = translations.slice(0, 5);
  const langPath = TURENG_URLS[word.lang] || "turkish-english";
  const turengUrl = `https://tureng.com/en/${langPath}/${encodeURIComponent(word.term)}`;

  let msg = `*${escapeMarkdown(word.term)}*`;
  if (word.lang) msg += `  \\[${LANG_LABELS[word.lang] || word.lang}\\]`;
  msg += "\n\n";

  top.forEach((t) => {
    const term = t.term || t.termB || "";
    const cat = t.category || "";
    msg += `• ${escapeMarkdown(term)}`;
    if (cat) msg += ` _(${escapeMarkdown(cat)})_`;
    msg += "\n";
  });

  if (translations.length > 5) {
    msg += `\n_\\+${translations.length - 5} more_\n`;
  }

  msg += `\n[View on Tureng](${turengUrl})`;

  const reviewInfo = [];
  if (word.review_count > 0) reviewInfo.push(`Review \\#${word.review_count}`);
  if (word.interval_days > 0) reviewInfo.push(`Interval: ${word.interval_days}d`);
  if (reviewInfo.length > 0) msg += `\n_${reviewInfo.join(" · ")}_`;

  return msg;
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

async function startBot(userId, botToken) {
  // Stop existing bot for this user if any
  await stopBot(userId);

  const bot = new Telegraf(botToken);

  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await db.updateUserTelegram(userId, { chatId });
    await ctx.reply(
      "Connected! You will receive flashcard reminders here.\n\n" +
      "Use /review to get a word to review now.\n" +
      "Use /stats to see your progress."
    );
    console.log(`Telegram linked for user ${userId}, chat ${chatId}`);
  });

  bot.command("review", async (ctx) => {
    const dueWords = await db.getDueWords(userId, 1);
    if (dueWords.length === 0) {
      await ctx.reply("No words due for review right now!");
      return;
    }
    await sendFlashcard(bot, ctx.chat.id, dueWords[0]);
  });

  bot.command("stats", async (ctx) => {
    const stats = await db.getStats(userId);
    const statusLines = stats.byStatus.map((s) => `  ${s.status}: ${s.count}`).join("\n");
    await ctx.reply(
      `Total words: ${stats.total}\nAdded today: ${stats.today}\n\n${statusLines}`
    );
  });

  // Handle flashcard button callbacks
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data) return;

    const [action, wordId] = data.split(":");
    if (!["again", "hard", "easy"].includes(action) || !wordId) return;

    const result = await db.updateWordReview(parseInt(wordId), userId, action);
    if (!result) {
      await ctx.answerCbQuery("Word not found");
      return;
    }

    const labels = { again: "Again — 1 day", hard: `Hard — ${result.interval_days}d`, easy: `Easy — ${result.interval_days}d` };
    await ctx.answerCbQuery(labels[action]);

    // Edit message to show result
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[
        { text: `${action.toUpperCase()} → ${result.interval_days}d (${result.status})`, callback_data: "noop" }
      ]]});
    } catch {}

    // Send next due word
    const nextWords = await db.getDueWords(userId, 1);
    if (nextWords.length > 0) {
      setTimeout(() => sendFlashcard(bot, ctx.chat.id, nextWords[0]), 1000);
    }
  });

  // Validate the token first
  try {
    await bot.telegram.getMe();
  } catch (err) {
    throw new Error(`Invalid bot token: ${err.message}`);
  }

  // launch() starts long-polling and never resolves — don't await it
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
    parse_mode: "MarkdownV2",
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
