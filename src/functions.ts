import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { Update } from 'grammy/types';
import {
  assertProductionProject, FIREBASE_PROJECT_ID, FUNCTION_REGION,
  readCommonConfig, readWebhookSecret, secretMatches,
} from './config.js';
import { loadCourse } from './course.js';
import { LearningEngine } from './engine.js';
import { FirestoreStateStore } from './storage.js';
import { createTelegramBot, deliverPending } from './telegram.js';

const botToken = defineSecret('BOT_TOKEN');
const webhookSecret = defineSecret('WEBHOOK_SECRET');
const allowedIds = defineSecret('ALLOWED_USER_IDS');
const adminIds = defineSecret('ADMIN_USER_IDS');
const accessMode = defineSecret('ACCESS_MODE');

function createRuntime() {
  assertProductionProject();
  const config = readCommonConfig({
    BOT_TOKEN: botToken.value(),
    ACCESS_MODE: accessMode.value(),
    ALLOWED_USER_IDS: allowedIds.value(),
    ADMIN_USER_IDS: adminIds.value(),
  });
  const app = getApps()[0] ?? initializeApp({ projectId: FIREBASE_PROJECT_ID });
  const engine = new LearningEngine({
    store: new FirestoreStateStore(getFirestore(app)),
    course: loadCourse(),
    accessMode: config.accessMode,
    allowedUserIds: config.allowedUserIds,
    adminUserIds: config.adminUserIds,
    requireMaintenanceIndexReady: true,
  });
  return { engine, bot: createTelegramBot(config.token, engine) };
}

let runtime: ReturnType<typeof createRuntime> | undefined;
let initializing: Promise<void> | undefined;
async function getRuntime() {
  runtime ??= createRuntime();
  if (!initializing) {
    initializing = runtime.bot.init().catch((error: unknown) => {
      initializing = undefined;
      throw error;
    });
  }
  await initializing;
  return runtime;
}

export const telegramWebhook = onRequest({
  region: FUNCTION_REGION,
  memory: '256MiB',
  minInstances: 0,
  maxInstances: 2,
  concurrency: 10,
  timeoutSeconds: 30,
  invoker: 'public',
  cors: false,
  secrets: [botToken, webhookSecret, allowedIds, adminIds, accessMode],
}, async (request, response) => {
  if (request.method !== 'POST') {
    response.set('Allow', 'POST').status(405).send('Method not allowed');
    return;
  }
  try {
    const expected = readWebhookSecret(webhookSecret.value());
    if (!secretMatches(expected, request.get('X-Telegram-Bot-Api-Secret-Token'))) {
      response.status(401).send('Unauthorized');
      return;
    }
    const update = request.body as Partial<Update> | undefined;
    if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id)) {
      response.status(400).send('Invalid update');
      return;
    }
    const { bot } = await getRuntime();
    await bot.handleUpdate(update as Update);
    response.status(200).send('OK');
  } catch {
    // Never serialize grammY errors: they can contain the request URL and token.
    console.error('telegram_webhook_failed');
    response.status(500).send('Temporary failure');
  }
});

export const maintenanceSchedule = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'UTC',
  region: FUNCTION_REGION,
  memory: '256MiB',
  minInstances: 0,
  maxInstances: 1,
  timeoutSeconds: 120,
  retryCount: 0,
  secrets: [botToken, allowedIds, adminIds, accessMode],
}, async () => {
  try {
    const { engine, bot } = await getRuntime();
    await deliverPending(bot, engine, await engine.maintenance());
  } catch {
    console.error('bot_maintenance_failed');
    throw new Error('Bot maintenance failed; pending deliveries will be retried on the next run.');
  }
});
