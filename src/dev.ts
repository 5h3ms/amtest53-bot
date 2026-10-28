import { config as loadDotEnv } from 'dotenv';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readLocalConfig, safeStartupError } from './config.js';
import { loadCourse } from './course.js';
import { LearningEngine } from './engine.js';
import { acquireLocalLock } from './local-lock.js';
import { FileStateStore, FirestoreStateStore, type StateStore } from './storage.js';
import { assertNoWebhook, createTelegramBot, deliverPending, DeliveryError } from './telegram.js';

loadDotEnv({ path: '.env.local', quiet: true });

async function main(): Promise<void> {
  const config = readLocalConfig();
  const unlock = await acquireLocalLock();
  let store: StateStore | undefined;
  try {
    store = config.storage === 'file'
      ? new FileStateStore(config.stateFile)
      : new FirestoreStateStore(getFirestore(initializeApp({ projectId: config.projectId }, 'local-bot')));
    const engine = new LearningEngine({
      store,
      course: loadCourse(),
      accessMode: config.accessMode,
      allowedUserIds: config.allowedUserIds,
      adminUserIds: config.adminUserIds,
    });
    const bot = createTelegramBot(config.token, engine);
    await assertNoWebhook(bot);
    bot.catch((failure) => {
      if (failure.error instanceof DeliveryError) {
        console.error('Ответ сохранён, но пока не доставлен. Локальный бот продолжает работу и повторит отправку.');
        return;
      }
      // Unexpected state/storage failures must not silently consume updates.
      throw new Error('Local bot handler failed. Details are hidden to protect secrets.');
    });
    let maintenanceTask: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (maintenanceTask) return;
      maintenanceTask = engine.maintenance()
        .then((pending) => deliverPending(bot, engine, pending))
        .catch(() => console.error('Не удалось отправить часть уведомлений; они будут повторены позже.'))
        .finally(() => { maintenanceTask = undefined; });
    }, 60_000);

    const stop = (): void => {
      clearInterval(timer);
      if (bot.isRunning()) void bot.stop();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      console.log(`Локальное хранилище: ${config.storage === 'file' ? '.local/state.json' : 'Firestore Emulator'}. Облачная база не используется.`);
      await bot.start({
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
        timeout: 5,
        onStart: (info) => console.log(`Бот @${info.username} запущен. Откройте Telegram и отправьте /start. Для остановки: Ctrl+C.`),
      });
    } finally {
      clearInterval(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await maintenanceTask;
    }
  } finally {
    try { await store?.close?.(); } finally { await unlock(); }
  }
}

void main().catch((error: unknown) => {
  console.error(safeStartupError(error));
  process.exitCode = 1;
});
