import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLocalLock } from '../src/local-lock.js';

const temporaryDirectories: string[] = [];
async function lockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'amtest53-lock-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'telegram.lock');
}
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // Only directories allocated above by this test process are removed.
    await rm(directory, { recursive: true, force: true });
  }
});

describe('single local Telegram process lock', () => {
  it('rejects a second active owner and permits startup after release', async () => {
    const path = await lockPath();
    const release = await acquireLocalLock({ path });
    await expect(acquireLocalLock({ path })).rejects.toThrow('уже запущен');
    await release();
    const releaseAgain = await acquireLocalLock({ path });
    await releaseAgain();
    await releaseAgain();
  });

  it('recovers a stale lock only after proving its PID is absent', async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ version: 1, pid: 10, nonce: 'old-owner' }));
    const release = await acquireLocalLock({ path, isProcessAlive: () => false });
    expect(JSON.parse(await readFile(path, 'utf8')).nonce).not.toBe('old-owner');
    await release();
  });

  it('fails closed for an empty or corrupt lock', async () => {
    const path = await lockPath();
    await writeFile(path, '');
    await expect(acquireLocalLock({ path, isProcessAlive: () => false })).rejects.toThrow();
    await writeFile(path, '{not-json');
    await expect(acquireLocalLock({ path, isProcessAlive: () => false })).rejects.toThrow('повреждена');
  });

  it('does not remove a replacement lock owned by another process', async () => {
    const path = await lockPath();
    const release = await acquireLocalLock({ path });
    const replacement = { version: 1, pid: 20, nonce: 'replacement-owner' };
    await writeFile(path, JSON.stringify(replacement));
    await release();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(replacement);
  });

  it('does not interrupt another stale-lock recovery', async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ version: 1, pid: 10, nonce: 'old-owner' }));
    await writeFile(`${path}.recovery`, '');
    await expect(acquireLocalLock({ path, isProcessAlive: () => false })).rejects.toThrow('проверяет блокировку');
  });
});
