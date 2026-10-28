import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { FieldPath, type Firestore } from "firebase-admin/firestore";
import { deriveMaintenanceIndex, isMaintenanceUser, MAINTENANCE_INDEX_VERSION } from "./maintenance-index.js";

export interface StateRecord {
  key: string;
  state: unknown;
}

export interface StatePageOptions {
  afterKey?: string;
  beforeKey?: string;
  limit?: number;
}

export interface StatePage {
  records: StateRecord[];
  nextCursor: string | null;
}

export interface DueCursor { at: number; key: string }
export interface DuePageOptions { after?: DueCursor; limit?: number }
export interface DuePage { records: StateRecord[]; nextCursor: DueCursor | null }
export interface StateUpdateGuard { key: string; check: (state: unknown | null) => boolean }

/**
 * State must consist of JSON values. Updaters must be synchronous and pure:
 * Firestore can invoke them more than once when retrying a transaction.
 */
export interface StateStore {
  read(key: string): Promise<unknown | null>;
  delete(key: string): Promise<void>;
  update<T>(
    key: string,
    fn: (current: unknown | null) => { state: unknown; result: T },
    guard?: StateUpdateGuard,
  ): Promise<T>;
  list(prefix: string): Promise<StateRecord[]>;
  /** Exclusive key cursor; each call reads a fresh page rather than a scan-wide snapshot. */
  listPage(prefix: string, options?: StatePageOptions): Promise<StatePage>;
  listDuePage(now: number, options?: DuePageOptions): Promise<DuePage>;
  close?(): Promise<void>;
}

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const PREFIX_PATTERN = /^[a-zA-Z0-9_-]*$/;
const MAX_LIST_RECORDS = 1_000;
const DEFAULT_PAGE_SIZE = 100;
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

function validateGuard(guard: StateUpdateGuard | undefined): void {
  if (guard === undefined) return;
  if (!guard || typeof guard.check !== 'function') throw new Error('Invalid state update guard');
  validateKey(guard.key);
}

function checkGuard(guard: StateUpdateGuard | undefined, current: unknown | null): void {
  if (guard && guard.check(current) !== true) throw new Error('State update guard rejected');
}

function validatePageOptions(prefix: string, options: StatePageOptions): { afterKey?: string; beforeKey?: string; limit: number } {
  validatePrefix(prefix);
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("State page options must be an object.");
  }
  const limit = options.limit === undefined ? DEFAULT_PAGE_SIZE : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_RECORDS) {
    throw new Error("State page limit must be a safe integer between 1 and 1000.");
  }
  if (options.afterKey !== undefined && options.beforeKey !== undefined) throw new Error("State page cursors are mutually exclusive");
  for (const cursor of [options.afterKey, options.beforeKey]) if (cursor !== undefined) {
    validateKey(cursor);
    if (!cursor.startsWith(prefix)) {
      throw new Error("State page cursor must match the requested prefix.");
    }
  }
  return { afterKey: options.afterKey, beforeKey: options.beforeKey, limit };
}

function pageFromRecords(records: ReadonlyMap<string, unknown>, prefix: string, options: { afterKey?: string; beforeKey?: string; limit: number }): StatePage {
  const keys = [...records.keys()]
    .filter(key => key.startsWith(prefix) && (options.afterKey === undefined || key > options.afterKey) &&
      (options.beforeKey === undefined || key < options.beforeKey))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0) * (options.beforeKey === undefined ? 1 : -1))
    .slice(0, options.limit + 1);
  const page = keys.slice(0, options.limit).map(key => ({ key, state: cloneJson(records.get(key)) }));
  const nextCursor = keys.length > options.limit ? page[page.length - 1]!.key : null;
  return { records: options.beforeKey === undefined ? page : page.reverse(), nextCursor };
}

function validateDueOptions(now: number, options: DuePageOptions): { after?: DueCursor; limit: number } {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error("Invalid maintenance time");
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error("Invalid due page options");
  const { limit } = validatePageOptions('', { limit: options.limit });
  if (options.after !== undefined) {
    if (!options.after || !Number.isFinite(options.after.at)) throw new Error("Invalid due page cursor");
    validateKey(options.after.key);
  }
  return { after: options.after, limit };
}

function dueFromRecords(records: ReadonlyMap<string, unknown>, now: number, options: { after?: DueCursor; limit: number }): DuePage {
  const matches = [...records].map(([key, state]) => ({ key, state, at: deriveMaintenanceIndex(state, key, now) }))
    .filter((entry): entry is { key: string; state: unknown; at: number } => entry.at !== null && entry.at <= now)
    .filter(entry => !options.after || entry.at > options.after.at || (entry.at === options.after.at && entry.key > options.after.key))
    .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, options.limit + 1);
  const page = matches.slice(0, options.limit), last = page[page.length - 1];
  return { records: page.map(({ key, state }) => ({ key, state: cloneJson(state) })),
    nextCursor: matches.length > options.limit && last ? { at: last.at, key: last.key } : null };
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

  async read(key: string): Promise<unknown | null> {
    validateKey(key);
    return this.serialize(() => this.records.has(key) ? cloneJson(this.records.get(key)) : null);
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.serialize(() => { this.records.delete(key); });
  }

  async update<T>(
    key: string,
    fn: (current: unknown | null) => { state: unknown; result: T },
    guard?: StateUpdateGuard,
  ): Promise<T> {
    validateKey(key);
    validateGuard(guard);
    return this.serialize(() => {
      if (guard) checkGuard(guard, this.records.has(guard.key) ? cloneJson(this.records.get(guard.key)) : null);
      const current = this.records.has(key) ? cloneJson(this.records.get(key)) : null;
      const outcome = fn(current);
      const next = cloneJson(outcome.state);
      if (next !== null || this.records.has(key)) this.records.set(key, next);
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

  async listPage(prefix: string, options: StatePageOptions = {}): Promise<StatePage> {
    const validated = validatePageOptions(prefix, options);
    return this.serialize(() => pageFromRecords(this.records, prefix, validated));
  }

  async listDuePage(now: number, options: DuePageOptions = {}): Promise<DuePage> {
    const validated = validateDueOptions(now, options);
    return this.serialize(() => dueFromRecords(this.records, now, validated));
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

  async read(key: string): Promise<unknown | null> {
    validateKey(key);
    return this.serialize(async () => {
      await this.load();
      return this.records.has(key) ? cloneJson(this.records.get(key)) : null;
    });
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.serialize(async () => {
      await this.load();
      if (!this.records.has(key)) return;
      const next = new Map(this.records);
      next.delete(key);
      await this.persist(next);
      this.records = next;
    });
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
    guard?: StateUpdateGuard,
  ): Promise<T> {
    validateKey(key);
    validateGuard(guard);
    return this.serialize(async () => {
      await this.load();
      if (guard) checkGuard(guard, this.records.has(guard.key) ? cloneJson(this.records.get(guard.key)) : null);
      const current = this.records.has(key) ? cloneJson(this.records.get(key)) : null;
      const outcome = fn(current);
      const next = cloneJson(outcome.state);
      if ((!this.records.has(key) && next === null) || JSON.stringify(this.records.get(key)) === JSON.stringify(next)) return outcome.result;
      const nextRecords = new Map(this.records);
      nextRecords.set(key, next);
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

  async listPage(prefix: string, options: StatePageOptions = {}): Promise<StatePage> {
    const validated = validatePageOptions(prefix, options);
    return this.serialize(async () => {
      await this.load();
      return pageFromRecords(this.records, prefix, validated);
    });
  }

  async listDuePage(now: number, options: DuePageOptions = {}): Promise<DuePage> {
    const validated = validateDueOptions(now, options);
    return this.serialize(async () => {
      await this.load();
      return dueFromRecords(this.records, now, validated);
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

  async read(key: string): Promise<unknown | null> {
    validateKey(key);
    const document = await this.db.collection("botState").doc(key).get();
    return document.exists ? parseFirestoreState(key, document.data()) : null;
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.db.collection("botState").doc(key).delete();
  }

  async update<T>(
    key: string,
    fn: (current: unknown | null) => { state: unknown; result: T },
    guard?: StateUpdateGuard,
  ): Promise<T> {
    validateKey(key);
    validateGuard(guard);
    const reference = this.db.collection("botState").doc(key);
    const now = Date.now();
    return this.db.runTransaction(async (transaction) => {
      const document = await transaction.get(reference);
      const previous = document.data();
      if (guard) {
        const guardDocument = guard.key === key ? document : await transaction.get(this.db.collection('botState').doc(guard.key));
        checkGuard(guard, guardDocument.exists ? parseFirestoreState(guard.key, guardDocument.data()) : null);
      }
      const outcome = fn(document.exists ? parseFirestoreState(key, previous) : null);
      validateJson(outcome.state);
      const stateJson = JSON.stringify(outcome.state);
      validateFirestoreStateSize(stateJson);
      if (!document.exists && outcome.state === null) return outcome.result;
      const indexed = isMaintenanceUser(outcome.state, key);
      const nextMaintenanceAt = indexed ? deriveMaintenanceIndex(outcome.state, key, now) : undefined;
      const metadataUnchanged = indexed
        ? previous?.maintenanceIndexVersion === MAINTENANCE_INDEX_VERSION && previous?.nextMaintenanceAt === nextMaintenanceAt
        : previous?.maintenanceIndexVersion === undefined && previous?.nextMaintenanceAt === undefined;
      if (previous?.stateJson !== stateJson || !metadataUnchanged) {
        transaction.set(reference, { key, version: 1, stateJson,
          ...(indexed ? { maintenanceIndexVersion: MAINTENANCE_INDEX_VERSION, nextMaintenanceAt } : {}) });
      }
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

  async listPage(prefix: string, options: StatePageOptions = {}): Promise<StatePage> {
    const { afterKey, beforeKey, limit } = validatePageOptions(prefix, options);
    const collection = this.db.collection("botState");
    // The mirrored key field supports reverse scans on Firestore implementations
    // that reject descending __name__-only scans. parseFirestoreState checks it.
    const orderField = beforeKey === undefined ? FieldPath.documentId() : 'key';
    const scoped = prefix
      ? collection.where(orderField, ">=", prefix).where(orderField, "<=", `${prefix}\uf8ff`)
      : collection;
    const ordered = scoped.orderBy(orderField, beforeKey === undefined ? 'asc' : 'desc');
    const cursor = beforeKey ?? afterKey;
    const query = cursor === undefined ? ordered : ordered.startAfter(cursor);
    const snapshot = await query.limit(limit + 1).get();
    const records = snapshot.docs.slice(0, limit).map(document => {
      validateKey(document.id);
      return { key: document.id, state: parseFirestoreState(document.id, document.data()) };
    });
    const nextCursor = snapshot.docs.length > limit ? records[records.length - 1]!.key : null;
    return { records: beforeKey === undefined ? records : records.reverse(), nextCursor };
  }

  async listDuePage(now: number, options: DuePageOptions = {}): Promise<DuePage> {
    const { after, limit } = validateDueOptions(now, options);
    const ordered = this.db.collection("botState").where("nextMaintenanceAt", "<=", now)
      .orderBy("nextMaintenanceAt", "asc").orderBy(FieldPath.documentId(), "asc");
    const query = after === undefined ? ordered : ordered.startAfter(after.at, after.key);
    const snapshot = await query.limit(limit + 1).get();
    const docs = snapshot.docs.slice(0, limit);
    const records = docs.map(document => {
      validateKey(document.id);
      return { key: document.id, state: parseFirestoreState(document.id, document.data()) };
    });
    const last = docs[docs.length - 1];
    return { records, nextCursor: snapshot.docs.length > limit && last
      ? { at: last.data().nextMaintenanceAt as number, key: last.id } : null };
  }
}
