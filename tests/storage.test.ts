import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateStore, FirestoreStateStore, MemoryStateStore, type StateStore } from "../src/storage.js";

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
  type Reference = { id: string };
  const documents = new Map<string, Document>();
  const db = {
    collection(name: string) {
      expect(name).toBe("botState");
      const bounds: Array<{ operator: string; value: string }> = [];
      let maximum = Infinity;
      const query = {
        doc: (id: string): Reference => ({ id }),
        where(_field: unknown, operator: string, value: string) {
          bounds.push({ operator, value });
          return query;
        },
        orderBy() { return query; },
        limit(value: number) { maximum = value; return query; },
        async get() {
          return {
            docs: [...documents.entries()]
              .filter(([id]) => bounds.every(({ operator, value }) => operator === ">=" ? id >= value : id <= value))
              .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
              .slice(0, maximum)
              .map(([id, data]) => ({ id, data: () => structuredClone(data) })),
          };
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
          return { exists: documents.has(reference.id), data: () => structuredClone(documents.get(reference.id)) };
        },
        set(reference, data) { writes.set(reference.id, structuredClone(data)); },
      });
      for (const [key, data] of writes) documents.set(key, data);
      return result;
    },
  };
  return { documents, store: new FirestoreStateStore(db as unknown as Firestore) };
}

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
