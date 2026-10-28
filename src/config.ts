import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

export const FIREBASE_PROJECT_ID = 'amtest53-bot';
export const DEMO_PROJECT_ID = 'demo-amtest53-bot';
export const FUNCTION_REGION = 'europe-west1';

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface CommonConfig {
  token: string;
  allowedUserIds: number[];
  adminUserIds: number[];
}

export interface LocalConfig extends CommonConfig {
  storage: 'file' | 'firestore';
  stateFile: string;
  projectId: typeof DEMO_PROJECT_ID;
}

/** Never include the rejected value in an error: values can be credentials. */
export function readBotToken(value: string | undefined): string {
  const token = value?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new ConfigurationError('Укажите действительный BOT_TOKEN в локальном файле настроек или Secret Manager.');
  }
  return token;
}

export function parseUserIds(value: string | undefined, name: string, required = false): number[] {
  if (!value?.trim()) {
    if (required) throw new ConfigurationError(`${name}: укажите хотя бы один Telegram ID. Узнать свой ID можно командой npm run identify.`);
    return [];
  }
  const parts = value.split(',').map((part) => part.trim());
  const ids = parts.map((part) => {
    if (!/^\d+$/.test(part)) throw new ConfigurationError(`${name}: ожидается список положительных Telegram ID через запятую.`);
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ConfigurationError(`${name}: Telegram ID должен быть положительным безопасным целым числом.`);
    return id;
  });
  return [...new Set(ids)];
}

export function readCommonConfig(env: NodeJS.ProcessEnv = process.env): CommonConfig {
  const token = readBotToken(env.BOT_TOKEN);
  const allowedUserIds = parseUserIds(env.ALLOWED_USER_IDS, 'ALLOWED_USER_IDS', true);
  const adminUserIds = parseUserIds(env.ADMIN_USER_IDS, 'ADMIN_USER_IDS');
  if (adminUserIds.some((id) => !allowedUserIds.includes(id))) {
    throw new ConfigurationError('Каждый ADMIN_USER_IDS должен также входить в ALLOWED_USER_IDS.');
  }
  return { token, allowedUserIds, adminUserIds };
}

export function readLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const common = readCommonConfig(env);
  const storage = env.LOCAL_STORAGE?.trim() || 'file';
  if (storage !== 'file' && storage !== 'firestore') {
    throw new ConfigurationError('LOCAL_STORAGE должен быть file или firestore.');
  }
  if (storage === 'firestore') {
    const host = env.FIRESTORE_EMULATOR_HOST?.trim();
    const match = host?.match(/^127\.0\.0\.1:(\d{1,5})$/);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
      throw new ConfigurationError('Локальный Firestore требует FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 (без http://). Обращение к облачной базе запрещено.');
    }
    if (env.GCLOUD_PROJECT !== DEMO_PROJECT_ID || (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT !== DEMO_PROJECT_ID)) {
      throw new ConfigurationError(`Для локального Firestore задайте GCLOUD_PROJECT=${DEMO_PROJECT_ID}.`);
    }
  }
  return { ...common, storage, stateFile: resolve('.local', 'state.json'), projectId: DEMO_PROJECT_ID };
}

export function readWebhookSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new ConfigurationError('WEBHOOK_SECRET должен содержать 32–256 символов A–Z, a–z, 0–9, _ или -.');
  }
  return secret;
}

export function secretMatches(expected: string, received: string | undefined): boolean {
  if (!received || received.length > 256) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

export function assertProductionProject(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FIRESTORE_EMULATOR_HOST) throw new ConfigurationError('Облачный вход не должен использовать Firestore Emulator.');
  const projectId = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  if (projectId !== FIREBASE_PROJECT_ID) {
    throw new ConfigurationError(`Облачный вход разрешён только для проекта ${FIREBASE_PROJECT_ID}.`);
  }
}

/** Credential-bearing network exceptions must never be printed verbatim. */
export function safeStartupError(error: unknown): string {
  return error instanceof ConfigurationError
    ? error.message
    : 'Запуск не удался. Проверьте подключение, токен и настройки. Подробности сетевого исключения скрыты, чтобы не раскрыть секреты.';
}
