import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConfigurationError } from './config.js';

interface LockRecord { version: 1; pid: number; nonce: string; }
interface LockOptions {
  path?: string;
  /** Overrides are for deterministic tests; normal callers use this process. */
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM also means a process exists. Never clear a lock on an uncertain result.
    return !hasCode(error, 'ESRCH');
  }
}

function parseRecord(raw: string): LockRecord | null {
  try {
    const record = JSON.parse(raw) as Partial<LockRecord>;
    if (record.version === 1 && Number.isSafeInteger(record.pid) && (record.pid ?? 0) > 0
      && typeof record.nonce === 'string' && record.nonce.length > 0) return record as LockRecord;
  } catch { /* A partially written or unknown lock must fail closed. */ }
  return null;
}

/** One local Telegram poller and file owner at a time, shared by dev and identify. */
export async function acquireLocalLock(options: LockOptions = {}): Promise<() => Promise<void>> {
  const path = options.path ?? resolve('.local', 'telegram.lock');
  const record: LockRecord = { version: 1, pid: options.pid ?? process.pid, nonce: randomUUID() };
  const isAlive = options.isProcessAlive ?? processAlive;
  await mkdir(dirname(path), { recursive: true });

  const writeLock = async (): Promise<void> => {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record), 'utf8'); } finally { await handle.close(); }
  };

  try {
    await writeLock();
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    // Serialize stale-lock recovery. Ordinary successful acquisition needs no
    // recovery guard, and can only win after a stale owner has been removed.
    const recoveryPath = `${path}.recovery`;
    let recoveryHandle;
    try {
      recoveryHandle = await open(recoveryPath, 'wx', 0o600);
    } catch (recoveryError) {
      if (hasCode(recoveryError, 'EEXIST')) {
        throw new ConfigurationError('Другой локальный запуск проверяет блокировку. Если предыдущий процесс аварийно завершился, убедитесь, что dev/identify остановлены, и удалите .local/telegram.lock.recovery.');
      }
      throw recoveryError;
    }
    try {
      let previousRaw: string;
      try { previousRaw = await readFile(path, 'utf8'); } catch (readError) {
        if (!hasCode(readError, 'ENOENT')) throw readError;
        previousRaw = '';
      }
      if (previousRaw) {
        const previous = parseRecord(previousRaw);
        if (!previous) throw new ConfigurationError('Локальная блокировка повреждена. Убедитесь, что dev/identify остановлены, затем удалите .local/telegram.lock.');
        if (isAlive(previous.pid)) throw new ConfigurationError('Локальный бот или identify уже запущен. Остановите предыдущую команду через Ctrl+C.');
        await unlink(path);
      } else {
        // An existing empty file may belong to an owner still writing its record.
        try {
          await readFile(path, 'utf8');
          throw new ConfigurationError('Локальная блокировка ещё не готова или повреждена. Не запускайте несколько копий бота.');
        } catch (readError) {
          if (!hasCode(readError, 'ENOENT')) throw readError;
        }
      }
      try { await writeLock(); } catch (writeError) {
        if (hasCode(writeError, 'EEXIST')) throw new ConfigurationError('Другой локальный запуск уже занял блокировку.');
        throw writeError;
      }
    } finally {
      await recoveryHandle.close();
      await unlink(recoveryPath);
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const current = parseRecord(await readFile(path, 'utf8'));
      if (current?.nonce === record.nonce && current.pid === record.pid) await unlink(path);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  };
}
