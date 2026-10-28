import { config } from 'dotenv';
import { Bot } from 'grammy';
import { readBotToken, readWebhookSecret, safeStartupError, ConfigurationError } from '../src/config.js';
config({ path: '.env.local', quiet: true });
try {
  const urlText = process.env.WEBHOOK_URL;
  if (!urlText) throw new ConfigurationError('Задайте WEBHOOK_URL из результата публикации Firebase в .env.local.');
  const url = new URL(urlText);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    !(url.hostname.endsWith('.cloudfunctions.net') || url.hostname.endsWith('.run.app'))) {
    throw new ConfigurationError('Ожидается HTTPS-адрес опубликованной Firebase Function без параметров и паролей.');
  }
  const bot = new Bot(readBotToken(process.env.BOT_TOKEN), { client: { timeoutSeconds: 10 } });
  const existing = await bot.api.getWebhookInfo();
  if (existing.url && existing.url !== url.href) throw new ConfigurationError('У бота уже есть другой webhook. Сначала проверьте выбранного бота и адрес; существующее подключение не изменено.');
  await bot.api.setWebhook(url.href, {
    secret_token: readWebhookSecret(process.env.WEBHOOK_SECRET),
    allowed_updates: ['message', 'callback_query'], max_connections: 1, drop_pending_updates: false,
  });
  const result = await bot.api.getWebhookInfo();
  if (result.url !== url.href) throw new Error('Webhook verification failed');
  console.log('Webhook зарегистрирован и проверен. Локальный polling этого бота теперь должен быть остановлен.');
} catch (error) { console.error(safeStartupError(error)); process.exitCode = 1; }
