import { config as loadDotEnv } from 'dotenv';
import { Bot } from 'grammy';
import { readBotToken, safeStartupError } from './config.js';
import { acquireLocalLock } from './local-lock.js';
import { assertNoWebhook, TELEGRAM_TIMEOUT_SECONDS } from './telegram.js';

loadDotEnv({ path: '.env.local', quiet: true });

async function main(): Promise<void> {
  const bot = new Bot(readBotToken(process.env.BOT_TOKEN), { client: { timeoutSeconds: TELEGRAM_TIMEOUT_SECONDS } });
  const unlock = await acquireLocalLock();
  try {
    await assertNoWebhook(bot);
    bot.command('start', (context) => {
      if (context.chat.type === 'private' && context.from && !context.from.is_bot) {
        console.log(`Ваш Telegram ID: ${context.from.id}. Добавьте его в ALLOWED_USER_IDS и ADMIN_USER_IDS в .env.local.`);
      }
    });
    const stop = (): void => { if (bot.isRunning()) void bot.stop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await bot.start({
        allowed_updates: ['message'],
        drop_pending_updates: false,
        timeout: 5,
        onStart: (info) => console.log(`Откройте @${info.username} и отправьте /start. ID появится только здесь. Затем остановите эту команду: Ctrl+C.`),
      });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } finally {
    await unlock();
  }
}

void main().catch((error: unknown) => {
  console.error(safeStartupError(error));
  process.exitCode = 1;
});
