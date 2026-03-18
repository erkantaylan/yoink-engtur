const cron = require("node-cron");
const db = require("./db");
const telegram = require("./telegram");

function start() {
  // Check for due reviews every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      const users = await db.getUsersWithTelegram();

      for (const user of users) {
        const settings = user.settings || {};
        if (settings.reminder_enabled === false) continue;

        // Check active hours
        const now = new Date();
        const hour = now.getHours();
        const startHour = settings.active_hours_start ?? 9;
        const endHour = settings.active_hours_end ?? 22;
        if (hour < startHour || hour >= endHour) continue;

        const bot = telegram.getBot(user.id);
        if (!bot) continue;

        const limit = settings.daily_limit ?? 20;
        const dueWords = await db.getDueWords(user.id, 1);

        if (dueWords.length === 0) continue;

        try {
          await telegram.sendFlashcard(bot, user.telegram_chat_id, dueWords[0]);
        } catch (err) {
          console.error(`Failed to send reminder to user ${user.username}:`, err.message);
        }
      }
    } catch (err) {
      console.error("Scheduler error:", err.message);
    }
  });

  console.log("Scheduler started (checking every 5 min)");
}

module.exports = { start };
