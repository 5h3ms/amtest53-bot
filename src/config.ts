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

const UNKNOWN_STARTUP_ERROR = 'Запуск не удался. Проверьте подключение, токен и настройки. Подробности сетевого исключения скрыты, чтобы не раскрыть секреты.';

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

function errorField(error: object, field: string): unknown {
  // Some third-party error properties may be getters. Diagnostics must not fail
  // while trying to describe the original failure, or stringify unknown values.
  try { return Reflect.get(error, field); } catch { return undefined; }
}

function knownStartupError(error: object): string | undefined {
  const telegramCode = errorField(error, 'error_code');
  if (telegramCode === 401 || telegramCode === 404) {
    return 'Telegram не принял BOT_TOKEN. Проверьте, что в .env.local указан полный действующий токен из BotFather, затем повторите запуск.';
  }
  if (telegramCode === 409) {
    return 'Telegram сообщает о конфликте запуска. Остановите другую копию этого бота; также проверьте, не установлен ли у него webhook.';
  }
  if (telegramCode === 429) {
    return 'Telegram временно ограничил частоту запросов. Подождите немного и повторите запуск.';
  }

  const code = errorField(error, 'code');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'Не удалось найти сервер Telegram через DNS. Проверьте подключение к интернету и настройки DNS, затем повторите запуск.';
  }
  if ((typeof code === 'string' && TIMEOUT_ERROR_CODES.has(code)) || errorField(error, 'name') === 'AbortError') {
    return 'Истекло время ожидания ответа Telegram. Проверьте интернет, VPN или прокси и повторите запуск.';
  }
  if (code === 'ECONNRESET') {
    return 'Соединение с Telegram было прервано. Проверьте интернет, VPN или прокси и повторите запуск.';
  }
  if (code === 'ECONNREFUSED') {
    return 'Соединение с Telegram отклонено. Проверьте VPN, прокси и сетевые ограничения, затем повторите запуск.';
  }
  if (typeof code === 'string' && TLS_ERROR_CODES.has(code)) {
    return 'Не удалось проверить TLS-сертификат соединения с Telegram. Проверьте дату и время компьютера, сертификаты и настройки прокси или антивируса.';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'Нет доступа к локальному файлу или папке. Проверьте права доступа и не заблокирован ли файл другим процессом.';
  }
  if (code === 'ENOENT') {
    return 'Не найден необходимый локальный файл. Запускайте команду из папки проекта и проверьте наличие его файлов.';
  }
  return undefined;
}

/** Classify structured fields only: network messages and URLs can contain tokens. */
export function safeStartupError(error: unknown): string {
  const queue: { error: unknown; depth: number }[] = [{ error, depth: 0 }];
  const seen = new Set<object>();
  // grammY HttpError exposes the underlying fetch failure as .error; Node fetch
  // commonly puts its socket/DNS failure in .cause. Both can be nested or cyclic.
  for (let index = 0; index < queue.length && index < 12; index += 1) {
    const current = queue[index]!;
    if (typeof current.error !== 'object' || current.error === null || seen.has(current.error)) continue;
    seen.add(current.error);
    if (current.error instanceof ConfigurationError) return current.error.message;
    const known = knownStartupError(current.error);
    if (known) return known;
    if (current.depth < 6) {
      queue.push(
        { error: errorField(current.error, 'error'), depth: current.depth + 1 },
        { error: errorField(current.error, 'cause'), depth: current.depth + 1 },
      );
    }
  }
  return UNKNOWN_STARTUP_ERROR;
}
