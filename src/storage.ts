import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { FieldPath, type Firestore } from "firebase-admin/firestore";

export interface StateRecord {
  key: string;
  state: unknown;
}

/**
 * State must consist of JSON values. Updaters must be synchronous and pure:
 * Firestore can invoke them more than once when retrying a transaction.
 */
export interface StateStore {
  update<T>(
    key: string,
    fn: (current: unknown | null) => { state: unknown; result: T },
  ): Promise<T>;
  list(prefix: string): Promise<StateRecord[]>;
  close?(): Promise<void>;
}

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const PREFIX_PATTERN = /^[a-zA-Z0-9_-]*$/;
const MAX_LIST_RECORDS = 1_000;
// Leave room for the document name, keys and envelope under Firestore's 1 MiB limit.
const MAX_FIRESTORE_STATE_BYTES = 900 * 1024;

function validateKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key) || key !== key.trim()) {
    throw new Error("State key must contain only letters, digits, underscores or hyphens.");
  }
}

function validatePrefix(prefix: string): void {
  if (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix) || prefix !== prefix.trim()) {
    throw new Error("State prefix must contain only letters, digits, underscores or hyphens.");
  }
}

function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") {
    throw new Error("State must contain only JSON values; undefined and non-finite numbers are not supported.");
  }
  if (ancestors.has(value)) throw new Error("State must not contain circular references.");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("State must contain only plain JSON objects and arrays.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const property of Reflect.ownKeys(value)) {
        if (property === "length") continue;
        if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) {
          throw new Error("State arrays must not contain custom properties.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          throw new Error("State arrays must not contain accessors or non-enumerable elements.");
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("State arrays must not contain empty slots.");
        validateJson(value[index], ancestors);
      }
    } else {
      for (const property of Reflect.ownKeys(value)) {
        if (typeof property !== "string") throw new Error("State must not contain symbol keys.");
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          throw new Error("State must not contain accessors or non-enumerable properties.");
        }
        validateJson(descriptor.value, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function cloneJson(value: unknown): unknown {
  validateJson(value);
  return JSON.parse(JSON.stringify(value)) as unknown;
}

abstract class SerializedStore {
  private pending: Promise<void> = Promise.resolve();

  protected serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    await this.pending;
  }
}

export class MemoryStateStore extends SerializedStore implements StateStore {
  private readonly records = new Map<string, unknown>();

  async update<T>(
    key: string,
    fn: (current: unknown | null) => { state: unknown; result: T },
  ): Promise<T> {
    validateKey(key);
    return this.serialize(() => {
      const current = this.records.has(key) ? cloneJson(this.records.get(key)) : null;
      const outcome = fn(current);
      this.records.set(key, cloneJson(outcome.state));
      return outcome.result;
    });
  }

  async list(prefix: string): Promise<StateRecord[]> {
    validatePrefix(prefix);
    return this.serialize(() =>
      [...this.records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, MAX_LIST_RECORDS)
        .map(([key, state]) => ({ key, state: cloneJson(state) })),
    );
  }
}

interface FileSnapshot {
  version: 1;
  records: Record<string, unknown>;
}

/**
 * Local development store. Exactly one application process may own a file.
 * Writes within that process are serialized and replace the file atomically.
 * Keep this file, exports and temporary files outside version control.
 */
export class FileStateStore extends SerializedStore implements StateStore {
  private readonly filePath: string;
  private loaded = false;
  private records = new Map<string, unknown>();

  constructor(filePath: string) {
    super();
    this.filePath = resolve(filePath);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw error;
    }

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(text) as unknown;
    } catch {
      throw new Error("Local state file contains invalid JSON. Restore a valid backup; existing data was not changed.");
    }
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot) ||
      (snapshot as Partial<FileSnapshot>).version !== 1 ||
      typeof (snapshot as Partial<FileSnapshot>).records !== "object" ||
      (snapshot as Partial<FileSnapshot>).records === null ||
      Array.isArray((snapshot as Partial<FileSnapshot>).records)
    ) {
      throw new Error("Local state file has an unsupported format. Existing data was not changed.");
    }
    const nextRecords = new Map<string, unknown>();
    for (const [key, state] of Object.entries((snapshot as FileSnapshot).records)) {
      validateKey(key);
      nextRecords.set(key, cloneJson(state));
    }
    this.records = nextRecords;
    this.loaded = true;
  }

  private async persist(records: Map<string, unknown>): Promise<void> {
    const parent = dirname(this.filePath);
    await mkdir(parent, { recursive: true });
    const snapshot: FileSnapshot = { version: 1, records: Object.fromEntries(records) };
    const temporaryPath = join(parent, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async update<T>(
    key: string,
    fn: (current: unknown | null) => { state: unknown; result: T },
  ): Promise<T> {
    validateKey(key);
    return this.serialize(async () => {
      await this.load();
      const current = this.records.has(key) ? cloneJson(this.records.get(key)) : null;
      const outcome = fn(current);
      const nextRecords = new Map(this.records);
      nextRecords.set(key, cloneJson(outcome.state));
      await this.persist(nextRecords);
      this.records = nextRecords;
      return outcome.result;
    });
  }

  async list(prefix: string): Promise<StateRecord[]> {
    validatePrefix(prefix);
    return this.serialize(async () => {
      await this.load();
      return [...this.records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, MAX_LIST_RECORDS)
        .map(([key, state]) => ({ key, state: cloneJson(state) }));
    });
  }
}

function validateFirestoreStateSize(stateJson: string): void {
  if (Buffer.byteLength(stateJson, "utf8") > MAX_FIRESTORE_STATE_BYTES) {
    throw new Error("Firestore state JSON exceeds the 900 KiB UTF-8 limit.");
  }
}

function parseFirestoreState(key: string, data: unknown): unknown {
  if (
    typeof data !== "object" || data === null ||
    !("key" in data) || data.key !== key ||
    !("version" in data) || data.version !== 1 ||
    !("stateJson" in data) || typeof data.stateJson !== "string"
  ) {
    throw new Error("Firestore state document has an invalid format.");
  }
  validateFirestoreStateSize(data.stateJson);
  let state: unknown;
  try {
    state = JSON.parse(data.stateJson) as unknown;
  } catch {
    throw new Error("Firestore state document contains invalid JSON.");
  }
  validateJson(state);
  return state;
}

/** JSON text preserves nested arrays, which Firestore fields cannot store directly. */
export class FirestoreStateStore implements StateStore {
  constructor(private readonly db: Firestore) {}

  async update<T>(
    key: string,
    fn: (current: unknown | null) => { state: unknown; result: T },
  ): Promise<T> {
    validateKey(key);
    const reference = this.db.collection("botState").doc(key);
    return this.db.runTransaction(async (transaction) => {
      const document = await transaction.get(reference);
      const outcome = fn(document.exists ? parseFirestoreState(key, document.data()) : null);
      validateJson(outcome.state);
      const stateJson = JSON.stringify(outcome.state);
      validateFirestoreStateSize(stateJson);
      transaction.set(reference, { key, version: 1, stateJson });
      return outcome.result;
    });
  }

  async list(prefix: string): Promise<StateRecord[]> {
    validatePrefix(prefix);
    const collection = this.db.collection("botState");
    const query = prefix
      ? collection
          .where(FieldPath.documentId(), ">=", prefix)
          .where(FieldPath.documentId(), "<=", `${prefix}\uf8ff`)
      : collection;
    const snapshot = await query.orderBy(FieldPath.documentId()).limit(MAX_LIST_RECORDS).get();
    return snapshot.docs.map((document) => {
      validateKey(document.id);
      return { key: document.id, state: parseFirestoreState(document.id, document.data()) };
    });
  }
}
