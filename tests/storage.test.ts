import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateStore, FirestoreStateStore, MemoryStateStore, type StateRecord, type StateStore } from "../src/storage.js";

const temporaryDirectories: string[] = [];

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amtest53-storage-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "state.json");
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const resolved = resolve(directory);
    const tempRoot = resolve(tmpdir());
    if (dirname(resolved) !== tempRoot || !resolved.startsWith(`${tempRoot}${sep}amtest53-storage-`)) {
      throw new Error("Refusing to remove a test directory outside the expected temporary root.");
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

const factories: Array<{ name: string; create: () => Promise<StateStore> }> = [
  { name: "memory", create: async () => new MemoryStateStore() },
  { name: "file", create: async () => new FileStateStore(await temporaryFile()) },
];

describe.each(factories)("$name state store", ({ create }) => {
  it("creates records, returns results and lists only the requested prefix", async () => {
    const store = await create();
    expect(await store.list("u_")).toEqual([]);
    const result = await store.update("u_2", (current) => {
      expect(current).toBeNull();
      return { state: { score: 3 }, result: "saved" };
    });
    await store.update("u_1", () => ({ state: { score: 1 }, result: undefined }));
    await store.update("meta_version", () => ({ state: { version: 1 }, result: undefined }));
    expect(result).toBe("saved");
    expect(await store.list("u_")).toEqual([
      { key: "u_1", state: { score: 1 } },
      { key: "u_2", state: { score: 3 } },
    ]);
    await store.close?.();
  });

  it("serializes concurrent read-modify-write operations", async () => {
    const store = await create();
    await store.update("u_1", () => ({ state: { count: 0 }, result: undefined }));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update("u_1", (current) => ({
          state: { count: (current as { count: number }).count + 1 },
          result: undefined,
        })),
      ),
    );
    expect((await store.list("u_"))[0]?.state).toEqual({ count: 20 });
  });

  it("does not commit mutations when an updater throws, and allows later updates", async () => {
    const store = await create();
    await store.update("u_1", () => ({ state: { count: 4 }, result: undefined }));
    await expect(
      store.update("u_1", (current) => {
        (current as { count: number }).count = 99;
        throw new Error("Abort transaction");
      }),
    ).rejects.toThrow("Abort transaction");
    expect((await store.list("u_"))[0]?.state).toEqual({ count: 4 });
    await store.update("u_1", () => ({ state: { count: 5 }, result: undefined }));
    expect((await store.list("u_"))[0]?.state).toEqual({ count: 5 });
  });

  it("isolates stored state from input, result and list mutation", async () => {
    const store = await create();
    const original = { answers: [1, 2] };
    const result = await store.update("u_1", () => ({ state: original, result: original }));
    original.answers.push(3);
    result.answers.push(4);
    const listing = await store.list("u_");
    (listing[0]?.state as { answers: number[] }).answers.push(5);
    expect((await store.list("u_"))[0]?.state).toEqual({ answers: [1, 2] });
  });

  it.each(["../users", "u/123", "", "u.123", "u\\123", "u_1\n"])("rejects invalid key %j", async (key) => {
    const store = await create();
    await expect(store.update(key, () => ({ state: {}, result: null }))).rejects.toThrow("State key");
  });

  it("rejects invalid list prefixes", async () => {
    const store = await create();
    await expect(store.list("../")).rejects.toThrow("State prefix");
  });

  it.each([
    undefined,
    { score: undefined },
    Number.NaN,
    Number.POSITIVE_INFINITY,
    { total: 1n },
    new Date("2026-10-28T00:00:00Z"),
    [1, undefined],
  ])("rejects unsupported JSON values without replacing previous state", async (state) => {
    const store = await create();
    await store.update("u_1", () => ({ state: { valid: true }, result: null }));
    await expect(store.update("u_1", () => ({ state, result: null }))).rejects.toThrow("State");
    expect((await store.list("u_"))[0]?.state).toEqual({ valid: true });
  });

  it("rejects circular objects", async () => {
    const store = await create();
    const state: { self?: unknown } = {};
    state.self = state;
    await expect(store.update("u_1", () => ({ state, result: null }))).rejects.toThrow("circular");
  });
});

describe("file persistence", () => {
  it("persists records across store instances and leaves no temporary files", async () => {
    const file = await temporaryFile();
    const original = new FileStateStore(file);
    await original.update("u_42", () => ({ state: { lesson: "l003", word: "քաղաքացի" }, result: null }));
    await original.close();
    const reopened = new FileStateStore(file);
    expect(await reopened.list("u_")).toEqual([
      { key: "u_42", state: { lesson: "l003", word: "քաղաքացի" } },
    ]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      records: { u_42: { lesson: "l003", word: "քաղաքացի" } },
    });
    expect(await readdir(dirname(file))).toEqual(["state.json"]);
  });

  it("close waits for pending writes", async () => {
    const file = await temporaryFile();
    const store = new FileStateStore(file);
    const update = store.update("u_1", () => ({ state: { saved: true }, result: null }));
    await store.close();
    await update;
    expect((await new FileStateStore(file).list("u_"))[0]?.state).toEqual({ saved: true });
  });

  it.each([
    "{invalid",
    "",
    '{"version":2,"records":{}}',
    '{"version":1,"records":[]}',
    '{"version":1,"records":null}',
    '{"version":1,"records":{"u/1":{}}}',
  ])("fails closed on a corrupt or unsupported state file", async (text) => {
    const nestedFile = await temporaryFile();
    const file = join(dirname(dirname(nestedFile)), "state.json");
    await writeFile(file, text, "utf8");
    const store = new FileStateStore(file);
    await expect(store.list("u_")).rejects.toThrow();
    await expect(store.update("u_1", () => ({ state: {}, result: null }))).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(text);
  });
});

// This adapter double checks the document representation without a live service.
// Transaction conflicts and SDK serialization are covered by the emulator suite.
function firestoreHarness() {
  type Document = Record<string, unknown>;
  type Reference = { id: string; get(): Promise<{ exists: boolean; data(): Document | undefined }>; delete(): Promise<void> };
  const documents = new Map<string, Document>();
  const counts = { reads: 0, writes: 0, queries: 0, queryReads: 0, deletes: 0 };
  const compare = (a: unknown, b: unknown) => a === b ? 0 : (a as number | string) < (b as number | string) ? -1 : 1;
  const db = {
    collection(name: string) {
      expect(name).toBe("botState");
      const bounds: Array<{ field: string; operator: string; value: unknown }> = [];
      const orders: Array<{ field: string; direction: string }> = [];
      let maximum = Infinity;
      let after: unknown[] | undefined;
      const fieldValue = (id: string, data: Document, field: string) => field === '__name__' ? id : data[field];
      const tupleCompare = (left: unknown[], right: unknown[]) => {
        for (const [index, order] of orders.entries()) {
          const comparison = compare(left[index], right[index]);
          if (comparison) return comparison * (order.direction === 'desc' ? -1 : 1);
        }
        return 0;
      };
      const query = {
        doc: (id: string): Reference => ({ id,
          async get() { counts.reads++; return { exists: documents.has(id), data: () => structuredClone(documents.get(id)) }; },
          async delete() { counts.deletes++; documents.delete(id); },
        }),
        where(field: unknown, operator: string, value: unknown) {
          bounds.push({ field: typeof field === 'string' ? field : '__name__', operator, value });
          return query;
        },
        orderBy(field: unknown, direction = 'asc') { orders.push({ field: typeof field === 'string' ? field : '__name__', direction }); return query; },
        startAfter(...values: unknown[]) { after = values; return query; },
        limit(value: number) { maximum = value; return query; },
        async get() {
          counts.queries++;
          const docs = [...documents.entries()]
              .filter(([id, data]) => bounds.every(({ field, operator, value }) => {
                const found = fieldValue(id, data, field);
                if (typeof found !== typeof value || found === null) return false;
                return operator === ">=" ? compare(found, value) >= 0 : compare(found, value) <= 0;
              }))
              .filter(([id, data]) => after === undefined || tupleCompare(orders.map(order => fieldValue(id, data, order.field)), after) > 0)
              .sort(([left, a], [right, b]) => tupleCompare(orders.map(order => fieldValue(left, a, order.field)), orders.map(order => fieldValue(right, b, order.field))))
              .slice(0, maximum)
              .map(([id, data]) => ({ id, data: () => structuredClone(data) }));
          counts.queryReads += docs.length;
          return { docs };
        },
      };
      return query;
    },
    async runTransaction<T>(operation: (transaction: {
      get(reference: Reference): Promise<{ exists: boolean; data(): Document | undefined }>;
      set(reference: Reference, data: Document): void;
    }) => Promise<T>): Promise<T> {
      const writes = new Map<string, Document>();
      const result = await operation({
        async get(reference) {
          counts.reads++;
          return { exists: documents.has(reference.id), data: () => structuredClone(documents.get(reference.id)) };
        },
        set(reference, data) { writes.set(reference.id, structuredClone(data)); },
      });
      for (const [key, data] of writes) { documents.set(key, data); counts.writes++; }
      return result;
    },
  };
  return { documents, counts, store: new FirestoreStateStore(db as unknown as Firestore) };
}

const paginationFactories: Array<{ name: string; create: (records: StateRecord[]) => Promise<StateStore> }> = [
  { name: "memory", create: async records => {
    const store = new MemoryStateStore();
    for (const record of records) await store.update(record.key, () => ({ state: record.state, result: null }));
    return store;
  } },
  { name: "file", create: async records => {
    const nestedFile = await temporaryFile();
    const file = join(dirname(dirname(nestedFile)), "pages.json");
    await writeFile(file, JSON.stringify({ version: 1, records: Object.fromEntries(records.map(record => [record.key, record.state])) }), "utf8");
    return new FileStateStore(file);
  } },
  { name: "Firestore adapter", create: async records => {
    const { store, documents } = firestoreHarness();
    for (const record of records) {
      documents.set(record.key, { key: record.key, version: 1, stateJson: JSON.stringify(record.state) });
    }
    return store;
  } },
];

describe.each(paginationFactories)("$name cursor pagination", ({ create }) => {
  it('atomically rejects stale owners before calling the updater or modifying its target', async () => {
    const store = await create([{ key: 'cache_manifest', state: { owner: 'new' } }, { key: 'cache_chunk', state: { value: 'published' } }]);
    let called = false;
    await expect(store.update('cache_chunk', current => {
      called = true;
      (current as { value: string }).value = 'stale overwrite';
      return { state: current, result: null };
    }, { key: 'cache_manifest', check: raw => (raw as { owner: string } | null)?.owner === 'old' })).rejects.toThrow('State update guard rejected');
    expect(called).toBe(false);
    expect(await store.read('cache_chunk')).toEqual({ value: 'published' });
    await expect(store.update('cache_new', () => ({ state: {}, result: null }),
      { key: 'missing_manifest', check: raw => raw !== null })).rejects.toThrow('State update guard rejected');
    expect(await store.read('cache_new')).toBeNull();
  });

  it('commits matching guarded writes and isolates guard mutations from persisted state', async () => {
    const store = await create([{ key: 'cache_manifest', state: { owner: 'current' } }]);
    const result = await store.update('cache_chunk', () => ({ state: { value: 'new snapshot' }, result: 42 }), {
      key: 'cache_manifest', check: raw => { const state = raw as { owner: string }; const matches = state.owner === 'current'; state.owner = 'mutated'; return matches; },
    });
    expect(result).toBe(42);
    expect(await store.read('cache_chunk')).toEqual({ value: 'new snapshot' });
    expect(await store.read('cache_manifest')).toEqual({ owner: 'current' });
    await expect(store.update('cache_chunk', () => { throw new Error('failure'); },
      { key: 'cache_manifest', check: () => true })).rejects.toThrow('failure');
    expect(await store.read('cache_chunk')).toEqual({ value: 'new snapshot' });
  });
  it('reads isolated records and deletes only the exact requested key', async () => {
    const store = await create([{ key: 'u_1', state: { value: [1] } }, { key: 'u_10', state: { value: [10] } }]);
    expect(await store.read('missing')).toBeNull();
    const value = await store.read('u_1') as { value: number[] };
    value.value.push(2);
    expect(await store.read('u_1')).toEqual({ value: [1] });
    await store.delete('u_1');
    await store.delete('missing');
    expect(await store.read('u_1')).toBeNull();
    expect(await store.read('u_10')).toEqual({ value: [10] });
    await expect(store.read('../')).rejects.toThrow('State key');
    await expect(store.delete('../')).rejects.toThrow('State key');
  });

  it('pages backwards with ascending results and exclusive cursors', async () => {
    const store = await create(['u_1', 'u_2', 'u_3', 'u_4', 'meta_1'].map(key => ({ key, state: {} })));
    const page = await store.listPage('u_', { beforeKey: 'u_4', limit: 2 });
    expect(page.records.map(x => x.key)).toEqual(['u_2', 'u_3']);
    expect(page.nextCursor).toBe('u_2');
    const first = await store.listPage('u_', { beforeKey: page.nextCursor!, limit: 2 });
    expect(first.records.map(x => x.key)).toEqual(['u_1']);
    expect(first.nextCursor).toBeNull();
    await expect(store.listPage('u_', { afterKey: 'u_1', beforeKey: 'u_4' })).rejects.toThrow('mutually exclusive');
  });
  it("uses exclusive lexical cursors, isolates prefixes and detects a full final page", async () => {
    const store = await create(["u_a", "u_2", "u_10", "u_1", "meta_1"]
      .map(key => ({ key, state: { values: [key] } })));
    const first = await store.listPage("u_", { limit: 2 });
    expect(first.records.map(record => record.key)).toEqual(["u_1", "u_10"]);
    expect(first.nextCursor).toBe("u_10");
    const last = await store.listPage("u_", { afterKey: first.nextCursor!, limit: 2 });
    expect(last.records.map(record => record.key)).toEqual(["u_2", "u_a"]);
    expect(last.nextCursor).toBeNull();
    expect(await store.listPage("u_", { afterKey: "u_a", limit: 2 })).toEqual({ records: [], nextCursor: null });
    expect((await store.listPage("u_", { afterKey: "u_15", limit: 1 })).records[0]?.key).toBe("u_2");
    expect((await store.listPage("", { limit: 1 })).records[0]?.key).toBe("meta_1");
    expect(await store.listPage("missing_")).toEqual({ records: [], nextCursor: null });
    (first.records[0]!.state as { values: string[] }).values.push("mutated");
    expect((await store.listPage("u_", { limit: 1 })).records[0]?.state).toEqual({ values: ["u_1"] });
  });

  it("traverses beyond 1000 records without omissions or duplicates while preserving list()'s cap", async () => {
    const records = Array.from({ length: 1007 }, (_, index) => ({
      key: `u_${String(index).padStart(4, "0")}`, state: { index },
    }));
    const store = await create([...records].reverse().concat([{ key: "meta_progress", state: { index: -1 } }]));
    const first = await store.listPage("u_");
    expect(first.records).toHaveLength(100);
    expect(first.nextCursor).toBe(records[99]!.key);
    const visited: StateRecord[] = [];
    let afterKey: string | undefined;
    do {
      const page = await store.listPage("u_", { afterKey, limit: 137 });
      visited.push(...page.records);
      afterKey = page.nextCursor ?? undefined;
    } while (afterKey !== undefined);
    expect(visited).toEqual(records);
    expect(new Set(visited.map(record => record.key)).size).toBe(records.length);
    expect(await store.list("u_")).toEqual(records.slice(0, 1000));
    const maximum = await store.listPage("u_", { limit: 1000 });
    expect(maximum.records).toHaveLength(1000);
    expect(maximum.nextCursor).toBe(records[999]!.key);
  });

  it("rejects invalid limits, prefixes and cursors before reading any records", async () => {
    const store = await create([]);
    for (const limit of [0, -1, 1.5, 1001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      await expect(store.listPage("u_", { limit: limit as number })).rejects.toThrow("State page limit");
    }
    for (const afterKey of ["", "../users", "u/1", "u_1\n", "meta_1"]) {
      await expect(store.listPage("u_", { afterKey })).rejects.toThrow(/State (key|page cursor)/);
    }
    await expect(store.listPage("../")).rejects.toThrow("State prefix");
    await expect(store.listPage("u_", null as never)).rejects.toThrow("State page options");
  });
});

const indexedUser = (userId: number, deadlineAt: number | null = null) => ({
  schema: 1, userId, chatId: userId, blocked: false, outbox: [],
  reminders: { enabled: false, time: '19:00', timeZone: 'Asia/Yerevan', lastSentDate: null },
  session: deadlineAt === null ? null : { kind: 'exam', deadlineAt, endedAt: null },
});

describe('Firestore operation savings and maintenance metadata', () => {
  it('skips unchanged writes and absent-null writes but still returns updater results', async () => {
    const { store, counts, documents } = firestoreHarness();
    expect(await store.update('empty', () => ({ state: null, result: 7 }))).toBe(7);
    expect(documents.has('empty')).toBe(false);
    expect(counts.writes).toBe(0);
    await store.update('cache_stats', () => ({ state: { count: 1 }, result: null }));
    await store.update('cache_stats', current => ({ state: current, result: null }));
    expect(counts).toMatchObject({ reads: 3, writes: 1 });
    expect(documents.get('cache_stats')).not.toHaveProperty('nextMaintenanceAt');
  });

  it('writes due metadata atomically, clears finished work, and repairs legacy envelopes once', async () => {
    const { store, counts, documents } = firestoreHarness();
    const deadline = Date.now() + 60_000;
    const state = indexedUser(1, deadline);
    documents.set('u_1', { key: 'u_1', version: 1, stateJson: JSON.stringify(state) });
    await store.update('u_1', current => ({ state: current, result: null }));
    expect(documents.get('u_1')).toMatchObject({ maintenanceIndexVersion: 1, nextMaintenanceAt: deadline });
    await store.update('u_1', current => ({ state: current, result: null }));
    expect(counts.writes).toBe(1);
    await store.update('u_1', () => ({ state: indexedUser(1), result: null }));
    expect(documents.get('u_1')).toMatchObject({ maintenanceIndexVersion: 1, nextMaintenanceAt: null });
    expect(JSON.parse(documents.get('u_1')!.stateJson as string)).toEqual(indexedUser(1));
  });

  it('queries only due users, with stable tied-time cursors, without reading idle users', async () => {
    const { store, documents, counts } = firestoreHarness();
    const now = Date.now();
    for (let id = 1; id <= 1000; id++) {
      const state = indexedUser(id);
      documents.set(`u_${id}`, { key: `u_${id}`, version: 1, stateJson: JSON.stringify(state), maintenanceIndexVersion: 1, nextMaintenanceAt: null });
    }
    for (const [id, at] of [[1, now - 1000], [2, now], [3, now], [4, now + 1000]] as const) {
      await store.update(`u_${id}`, () => ({ state: indexedUser(id, at), result: null }));
    }
    const first = await store.listDuePage(now, { limit: 2 });
    expect(first.records.map(x => x.key)).toEqual(['u_1', 'u_2']);
    expect(first.nextCursor).toEqual({ at: now, key: 'u_2' });
    await store.update('u_1', () => ({ state: indexedUser(1), result: null }));
    const last = await store.listDuePage(now, { limit: 2, after: first.nextCursor! });
    expect(last.records.map(x => x.key)).toEqual(['u_3']);
    expect(last.nextCursor).toBeNull();
    expect(counts.queryReads).toBe(4); // Three due documents plus one page lookahead, not 1000 users.
    expect(counts.queries).toBe(2);
  });
});

describe.each(factories)('$name maintenance selection', ({ create }) => {
  it('selects due states consistently with the Firestore adapter', async () => {
    const store = await create(), now = Date.now();
    for (let id = 1; id <= 4; id++) await store.update(`u_${id}`, () => ({ state: indexedUser(id, id === 4 ? null : now), result: null }));
    const page = await store.listDuePage(now, { limit: 2 });
    expect(page.records.map(x => x.key)).toEqual(['u_1', 'u_2']);
    expect(page.nextCursor).toEqual({ at: now, key: 'u_2' });
    expect((await store.listDuePage(now, { after: page.nextCursor!, limit: 2 })).records.map(x => x.key)).toEqual(['u_3']);
    await expect(store.listDuePage(NaN)).rejects.toThrow('maintenance time');
    await expect(store.listDuePage(now, { after: { at: NaN, key: 'u_1' } })).rejects.toThrow('cursor');
    await expect(store.listDuePage(now, { limit: 0 })).rejects.toThrow('limit');
  });
});

describe("Firestore JSON document representation", () => {
  it("round-trips nested button rows and keeps returned objects isolated", async () => {
    const { store, documents } = firestoreHarness();
    const original = {
      schema: 1,
      outbox: [{ id: "event_1", userId: 42, chatId: 42,
        view: { text: "Հայաստան", buttons: [[{ text: "Начать", data: "menu:today" }], [{ text: "Меню", data: "menu:home" }]] },
      }],
    };
    const expected = structuredClone(original);
    const returned = await store.update("u_42", () => ({ state: original, result: original }));
    expect(documents.get("u_42")).toEqual({ key: "u_42", version: 1, stateJson: JSON.stringify(expected) });
    returned.outbox[0]!.view.buttons[0]![0]!.text = "changed";
    const listed = await store.list("u_");
    expect(listed).toEqual([{ key: "u_42", state: expected }]);
    (listed[0]!.state as typeof expected).outbox.length = 0;
    await store.update("u_42", current => {
      expect(current).toEqual(expected);
      return { state: current, result: null };
    });
    expect((await store.list("u_"))[0]?.state).toEqual(expected);
  });

  it.each([
    { key: "u_42", state: {} },
    { key: "u_42", version: 2, stateJson: "{}" },
    { key: "u_42", version: 1, stateJson: {} },
    { key: "u_99", version: 1, stateJson: "{}" },
    { key: "u_42", version: 1, stateJson: "{invalid" },
    { key: "u_42", version: 1, stateJson: '{"value":1e400}' },
  ])("rejects corrupt documents on both read paths without overwriting them", async document => {
    const { store, documents } = firestoreHarness();
    documents.set("u_42", document);
    let called = false;
    await expect(store.update("u_42", () => {
      called = true;
      return { state: {}, result: null };
    })).rejects.toThrow();
    await expect(store.list("u_")).rejects.toThrow();
    expect(called).toBe(false);
    expect(documents.get("u_42")).toEqual(document);
  });

  it("rejects invalid JSON state and failed updaters without changing the saved document", async () => {
    const { store, documents } = firestoreHarness();
    await store.update("u_42", () => ({ state: { count: 1 }, result: null }));
    const original = structuredClone(documents.get("u_42"));
    await expect(store.update("u_42", () => ({ state: { invalid: undefined }, result: null }))).rejects.toThrow("JSON");
    await expect(store.update("u_42", current => {
      (current as { count: number }).count = 9;
      throw new Error("Abort transaction");
    })).rejects.toThrow("Abort transaction");
    expect(documents.get("u_42")).toEqual(original);
  });

  it("enforces the 900 KiB UTF-8 limit on writes and reads", async () => {
    const { store, documents } = firestoreHarness();
    const atLimit = "հ".repeat((900 * 1024 - 2) / 2);
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(900 * 1024);
    await store.update("u_42", () => ({ state: atLimit, result: null }));
    const original = structuredClone(documents.get("u_42"));
    const tooLarge = `${atLimit}հ`;
    await expect(store.update("u_42", () => ({ state: tooLarge, result: null }))).rejects.toThrow("900 KiB UTF-8");
    expect(documents.get("u_42")).toEqual(original);
    documents.set("u_42", { key: "u_42", version: 1, stateJson: JSON.stringify(tooLarge) });
    await expect(store.list("u_")).rejects.toThrow("900 KiB UTF-8");
    await expect(store.update("u_42", () => ({ state: null, result: null }))).rejects.toThrow("900 KiB UTF-8");
  });
});
