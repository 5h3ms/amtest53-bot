import { describe, expect, it } from 'vitest';
import { GrammyError, HttpError } from 'grammy';
import {
  assertProductionProject, ConfigurationError, DEMO_PROJECT_ID, parseUserIds,
  readBotToken, readCommonConfig, readLocalConfig, readWebhookSecret, safeStartupError, secretMatches,
} from '../src/config.js';

// Synthetic, deliberately invalid on Telegram; never a real credential.
const testToken = `1:${'x'.repeat(24)}`;
const valid = { BOT_TOKEN: testToken, ALLOWED_USER_IDS: '1,2', ADMIN_USER_IDS: '1' };

describe('runtime configuration safety', () => {
  it('requires a local allowlist and rejects malformed or unsafe IDs', () => {
    expect(() => readCommonConfig({ BOT_TOKEN: testToken })).toThrow(ConfigurationError);
    for (const raw of ['1,', '-1', '0', '1x', '1.5', '9007199254740992']) {
      expect(() => parseUserIds(raw, 'ALLOWED_USER_IDS')).toThrow(ConfigurationError);
    }
    expect(parseUserIds('1, 2,1', 'IDS')).toEqual([1, 2]);
  });

  it('requires administrators to also have learner access', () => {
    expect(() => readCommonConfig({ ...valid, ADMIN_USER_IDS: '3' })).toThrow(ConfigurationError);
  });

  it('uses a local file by default, independent of cloud credentials', () => {
    expect(readLocalConfig({ ...valid, GCLOUD_PROJECT: 'amtest53-bot' }).storage).toBe('file');
  });

  it('cannot silently use production Firestore in local mode', () => {
    for (const overrides of [
      {},
      { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443', GCLOUD_PROJECT: DEMO_PROJECT_ID },
      { FIRESTORE_EMULATOR_HOST: 'http://127.0.0.1:8080', GCLOUD_PROJECT: DEMO_PROJECT_ID },
      { FIRESTORE_EMULATOR_HOST: '127.0.0.1:0', GCLOUD_PROJECT: DEMO_PROJECT_ID },
      { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', GCLOUD_PROJECT: 'amtest53-bot' },
    ]) {
      expect(() => readLocalConfig({ ...valid, LOCAL_STORAGE: 'firestore', ...overrides })).toThrow(ConfigurationError);
    }
    expect(readLocalConfig({
      ...valid, LOCAL_STORAGE: 'firestore', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', GCLOUD_PROJECT: DEMO_PROJECT_ID,
    }).projectId).toBe(DEMO_PROJECT_ID);
  });

  it('does not leak credentials through errors', () => {
    const sensitive = 'not-a-token-DO-NOT-PRINT';
    try { readBotToken(sensitive); } catch (error) { expect(safeStartupError(error)).not.toContain(sensitive); }
    expect(safeStartupError(new Error(`https://api.telegram.org/bot${testToken}`))).not.toContain(testToken);
  });

  it('authenticates webhook secrets exactly', () => {
    const secret = readWebhookSecret('a'.repeat(32));
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches(secret, undefined)).toBe(false);
    expect(secretMatches(secret, `${secret}a`)).toBe(false);
    expect(secretMatches(secret, 'b'.repeat(32))).toBe(false);
    expect(() => readWebhookSecret('short')).toThrow(ConfigurationError);
  });

  it('guards the production entrypoint against the wrong project', () => {
    expect(() => assertProductionProject({ GCLOUD_PROJECT: 'another-project' })).toThrow(ConfigurationError);
    expect(() => assertProductionProject({ GCLOUD_PROJECT: 'amtest53-bot', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(ConfigurationError);
    expect(() => assertProductionProject({ GCLOUD_PROJECT: 'amtest53-bot' })).not.toThrow();
  });
});

describe('safe startup diagnostics', () => {
  const secretUrl = `https://api.telegram.org/bot${testToken}/getMe`;

  function expectRedacted(message: string): void {
    expect(message).not.toContain(testToken);
    expect(message).not.toContain(secretUrl);
    expect(message).not.toContain('https://');
  }

  it.each([
    [401, 'не принял BOT_TOKEN'],
    [404, 'не принял BOT_TOKEN'],
    [409, 'конфликте запуска'],
    [429, 'ограничил частоту запросов'],
  ])('explains Telegram API %i without its credential-bearing description', (code, expected) => {
    const error = new GrammyError(secretUrl, {
      ok: false, error_code: code, description: secretUrl,
    }, 'getMe', { token: testToken });
    const message = safeStartupError(error);
    expect(message).toContain(expected);
    expectRedacted(message);
  });

  it.each([
    ['ENOTFOUND', 'DNS'],
    ['EAI_AGAIN', 'DNS'],
    ['ETIMEDOUT', 'время ожидания'],
    ['ESOCKETTIMEDOUT', 'время ожидания'],
    ['UND_ERR_CONNECT_TIMEOUT', 'время ожидания'],
    ['ECONNRESET', 'было прервано'],
    ['ECONNREFUSED', 'отклонено'],
    ['CERT_HAS_EXPIRED', 'TLS-сертификат'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS-сертификат'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS-сертификат'],
    ['EACCES', 'Нет доступа к локальному'],
    ['EPERM', 'Нет доступа к локальному'],
    ['ENOENT', 'Не найден необходимый локальный файл'],
  ])('finds %s through grammY and fetch wrappers without printing URLs or paths', (code, expected) => {
    const socketError = Object.assign(new Error(secretUrl), { code, path: secretUrl });
    const fetchError = new TypeError(secretUrl, { cause: socketError });
    const error = new HttpError(secretUrl, fetchError);
    const message = safeStartupError(error);
    expect(message).toContain(expected);
    expectRedacted(message);
  });

  it('recognizes aborts without relying on their message', () => {
    const error = new HttpError(secretUrl, Object.assign(new Error(secretUrl), { name: 'AbortError' }));
    const message = safeStartupError(error);
    expect(message).toContain('время ожидания');
    expectRedacted(message);
  });

  it('preserves a trusted configuration message', () => {
    const message = 'ALLOWED_USER_IDS: укажите хотя бы один Telegram ID.';
    expect(safeStartupError(new ConfigurationError(message))).toBe(message);
  });

  it('does not infer codes from untrusted messages or print unknown errors', () => {
    for (const error of [new Error(`ENOTFOUND ${secretUrl}`), secretUrl, { code: secretUrl, message: secretUrl }, null]) {
      const message = safeStartupError(error);
      expect(message).toContain('Запуск не удался');
      expectRedacted(message);
    }
  });

  it('handles cyclic wrappers and bounds deeply nested causes', () => {
    const cyclic: { error?: unknown; cause?: unknown } = {};
    cyclic.error = cyclic;
    cyclic.cause = { code: 'EAI_AGAIN', message: secretUrl };
    expect(safeStartupError(cyclic)).toContain('DNS');

    let deep: unknown = { code: 'EAI_AGAIN', message: secretUrl };
    for (let depth = 0; depth < 30; depth += 1) deep = { cause: deep };
    expect(safeStartupError(deep)).toContain('Запуск не удался');
  });

  it('ignores throwing diagnostic getters without exposing their exceptions', () => {
    const error = Object.defineProperty({}, 'error_code', { get() { throw new Error(secretUrl); } });
    const message = safeStartupError(error);
    expect(message).toContain('Запуск не удался');
    expectRedacted(message);
  });
});
