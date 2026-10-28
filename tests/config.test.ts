import { describe, expect, it } from 'vitest';
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
