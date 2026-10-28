import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { FieldPath, getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCourse } from "../src/course.js";
import { LearningEngine, type UserState } from "../src/engine.js";
import { FirestoreStateStore, type StateStore } from "../src/storage.js";
import { deliverPending } from '../src/telegram.js';
import type { Bot } from 'grammy';
import { backfillMaintenanceIndex, MAINTENANCE_READY_KEY } from '../src/maintenance-migration.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;
const safeEmulator = Boolean(
  emulatorHost &&
    /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(emulatorHost) &&
    projectId?.startsWith("demo-"),
);

describe.skipIf(!safeEmulator)("Firestore state store (local demo emulator only)", () => {
  let app: App;
  let db: Firestore;
  let store: FirestoreStateStore;
  const prefix = `test_${randomUUID().replaceAll("-", "")}_`;
  const ownedUserKeys: string[] = [];
  let ownsMigrationMarker = false;

  beforeAll(() => {
    app = initializeApp({ projectId: projectId! }, `storage-test-${randomUUID()}`);
    db = getFirestore(app);
    store = new FirestoreStateStore(db);
  });

  afterAll(async () => {
    if (!db || !app) return;
    // Delete only documents created under this run's unique prefix, in the demo emulator.
    // Query raw documents so cleanup also works after corruption-validation tests.
    const records = await db.collection("botState")
      .where(FieldPath.documentId(), ">=", prefix)
      .where(FieldPath.documentId(), "<=", `${prefix}\uf8ff`).get();
    for (let offset = 0; offset < records.docs.length; offset += 500) {
      const batch = db.batch();
      for (const record of records.docs.slice(offset, offset + 500)) batch.delete(record.ref);
      await batch.commit();
    }
    for (const key of ownedUserKeys) await db.collection('botState').doc(key).delete();
    if (ownsMigrationMarker) await db.collection('botState').doc(MAINTENANCE_READY_KEY).delete();
    await deleteApp(app);
  });

  it("commits concurrent increments without losing changes", async () => {
    const key = `${prefix}count`;
    await store.update(key, () => ({ state: { count: 0 }, result: null }));
    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.update(key, (current) => ({
          state: { count: (current as { count: number }).count + 1 },
          result: null,
        })),
      ),
    );
    expect((await store.list(key))[0]?.state).toEqual({ count: 5 });
  }, 30_000);

  it('indexes pending work atomically, uses two transactions for delivery and does not rewrite a duplicate', async () => {
    const userId = Date.now() * 1000 + 1;
    const userKey = `u_${userId}`; ownedUserKeys.push(userKey);
    const engine = new LearningEngine({ store, course: loadCourse(), accessMode: 'private', allowedUserIds: [userId], adminUserIds: [] });
    const event = { userId, chatId: userId, eventId: `cost-${randomUUID()}`, text: '/start' };
    const transaction = vi.spyOn(db, 'runTransaction');
    const [delivery] = await engine.handle(event, true);
    expect(delivery?.leaseToken).toEqual(expect.any(String));
    const before = (await db.collection('botState').doc(userKey).get()).data()!;
    expect(before.maintenanceIndexVersion).toBe(1);
    expect(before.nextMaintenanceAt).toBe(delivery!.leaseUntil);
    expect((await store.listDuePage(Date.now())).records.some(record => record.key === userKey)).toBe(false);
    const bot = { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } };
    await deliverPending(bot as unknown as Bot, engine, [delivery!]);
    expect(transaction).toHaveBeenCalledTimes(2);
    transaction.mockRestore();
    const acknowledged = await db.collection('botState').doc(userKey).get();
    expect(acknowledged.data()!.nextMaintenanceAt).toBeNull();
    expect(await engine.handle(event, true)).toEqual([]);
    const duplicate = await db.collection('botState').doc(userKey).get();
    expect(duplicate.updateTime!.isEqual(acknowledged.updateTime!)).toBe(true);
    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
  }, 30_000);

  it('queries only due users with stable time-and-ID cursors and reads user pages backwards', async () => {
    const firstId = Date.now() * 1000 + 10, now = Date.now();
    const engine = new LearningEngine({ store, course: loadCourse(), accessMode: 'public', allowedUserIds: [], adminUserIds: [] });
    const deliveries = [];
    for (let index = 0; index < 4; index++) {
      const userId = firstId + index; ownedUserKeys.push(`u_${userId}`);
      const [delivery] = await engine.handle({ userId, chatId: userId, eventId: `due-${index}`, text: '/start', now });
      deliveries.push(delivery!);
      if (index === 3) await engine.acknowledge(userId, delivery!.id);
    }
    const seen: string[] = []; let after: { at: number; key: string } | undefined;
    do {
      const page = await store.listDuePage(now, { after, limit: 1 });
      seen.push(...page.records.map(record => record.key));
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    } while (true);
    expect(seen.filter(key => ownedUserKeys.includes(key))).toEqual(deliveries.slice(0, 3).map(delivery => `u_${delivery.userId}`));
    const reverse = await store.listPage('u_', { beforeKey: `u_${firstId + 3}`, limit: 2 });
    expect(reverse.records.map(record => record.key)).toEqual([`u_${firstId + 1}`, `u_${firstId + 2}`]);
    for (const delivery of deliveries) await engine.acknowledge(delivery.userId, delivery.id);
  }, 30_000);

  it('backfills real legacy documents without rewriting JSON and activates only after verification', async () => {
    const userId = Date.now() * 1000 + 20, userKey = `u_${userId}`;
    ownedUserKeys.push(userKey); ownsMigrationMarker = true;
    const engine = new LearningEngine({ store, course: loadCourse(), accessMode: 'private', allowedUserIds: [userId], adminUserIds: [] });
    await engine.handle({ userId, chatId: userId, eventId: 'legacy-migration', text: '/start' });
    const reference = db.collection('botState').doc(userKey);
    const original = (await reference.get()).data()!;
    // Model the previous envelope exactly, retaining even its JSON formatting.
    const stateJson = JSON.stringify(JSON.parse(original.stateJson as string), null, 2);
    await reference.set({ key: userKey, version: 1, stateJson });
    const dry = await backfillMaintenanceIndex(db, { apply: false });
    expect(dry.updated).toBeGreaterThanOrEqual(1);
    expect(dry.readyPublished).toBe(false);
    expect((await reference.get()).data()!.stateJson).toBe(stateJson);
    const applied = await backfillMaintenanceIndex(db, { apply: true });
    expect(applied).toMatchObject({ invalid: 0, missing: 0, verificationInvalid: 0, verificationMissing: 0, readyPublished: true });
    const indexed = (await reference.get()).data()!;
    expect(indexed.stateJson).toBe(stateJson);
    expect(indexed.maintenanceIndexVersion).toBe(1);
    expect(typeof indexed.nextMaintenanceAt).toBe('number');
    const repeat = await backfillMaintenanceIndex(db, { apply: true });
    expect(repeat.updated).toBe(0);
    expect(repeat.readyPublished).toBe(true);
  }, 30_000);

  it("supports atomic deduplication of a repeated Telegram update", async () => {
    const key = `${prefix}dedupe`;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        store.update(key, (current) => {
          const state = (current as { eventIds: string[]; score: number } | null) ?? {
            eventIds: [],
            score: 0,
          };
          if (!state.eventIds.includes("update-123")) {
            state.eventIds.push("update-123");
            state.score += 1;
          }
          return { state, result: null };
        }),
      ),
    );
    expect((await store.list(key))[0]?.state).toEqual({ eventIds: ["update-123"], score: 1 });
  }, 30_000);

  it("does not overwrite previous state when the updater throws", async () => {
    const key = `${prefix}abort`;
    await store.update(key, () => ({ state: { score: 1 }, result: null }));
    await expect(
      store.update(key, (current) => {
        (current as { score: number }).score = 20;
        throw new Error("Abort transaction");
      }),
    ).rejects.toThrow("Abort transaction");
    expect((await store.list(key))[0]?.state).toEqual({ score: 1 });
  });

  it("persists engine sessions, analytics and feedback without counting retried answers twice", async () => {
    const namespacedStore: StateStore = {
      read: key => store.read(`${prefix}${key}`),
      delete: key => store.delete(`${prefix}${key}`),
      listDuePage: (now, options) => store.listDuePage(now, options),
      update: (key, fn) => store.update(`${prefix}${key}`, fn),
      list: async filter => (await store.list(`${prefix}${filter}`))
        .map(record => ({ key: record.key.slice(prefix.length), state: record.state })),
      listPage: async (filter, options = {}) => {
        const page = await store.listPage(`${prefix}${filter}`, {
          ...options, afterKey: options.afterKey === undefined ? undefined : `${prefix}${options.afterKey}`,
        });
        return { records: page.records.map(record => ({ key: record.key.slice(prefix.length), state: record.state })),
          nextCursor: page.nextCursor === null ? null : page.nextCursor.slice(prefix.length) };
      },
    };
    const engine = new LearningEngine({
      store: namespacedStore, course: loadCourse(), allowedUserIds: [42], adminUserIds: [],
    });
    const event = { userId: 42, chatId: 42, eventId: "nested-buttons", text: "/start", now: Date.now() };
    const deliveries = await engine.handle(event);
    expect(deliveries[0]?.view.buttons?.[0]?.length).toBeGreaterThan(0);
    expect(await engine.handle(event)).toEqual(deliveries);
    const document = (await db.collection("botState").doc(`${prefix}u_42`).get()).data()!;
    expect(Object.keys(document).sort()).toEqual(["key", "stateJson", "version"]);
    expect(document.version).toBe(1);
    expect(typeof document.stateJson).toBe("string");
    const state = (await namespacedStore.list("u_"))[0]!.state as UserState;
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.view).toEqual(deliveries[0]?.view);
    expect(JSON.parse(document.stateJson as string)).toEqual(state);
    await engine.handle({ ...event, eventId: 'start-practice', text: undefined, action: 'menu:practice' });
    const started = (await namespacedStore.list('u_'))[0]!.state as UserState;
    const session = started.session!, step = session.steps[0]!;
    if (step.kind !== 'question') throw new Error('Expected a question');
    const answerEvent = { ...event, eventId: 'answer-with-retries', text: undefined,
      action: `answer:${session.id}:0:${step.question.correctIndex}` };
    await Promise.all(Array.from({ length: 3 }, () => engine.handle(answerEvent)));
    const answered = (await namespacedStore.list('u_'))[0]!.state as UserState;
    expect(answered.attempts).toBe(1);
    expect(answered.questionProgress?.[step.question.id]?.seen).toBe(1);
    expect(Object.values(answered.analytics!.days).reduce((sum, day) => sum + day.answers, 0)).toBe(1);
    await engine.handle({ ...event, eventId: 'report-start', text: undefined, action: `report:${session.id}:0` });
    const reporting = (await namespacedStore.list('u_'))[0]!.state as UserState;
    const token = reporting.feedback!.pending!.token;
    await engine.handle({ ...event, eventId: 'report-category', text: undefined, action: `feedback:${token}:category:translation` });
    await engine.handle({ ...event, eventId: 'report-description', text: 'Проверьте перевод вопроса.' });
    const reloaded = (await namespacedStore.list('u_'))[0]!.state as UserState;
    expect(reloaded.feedback?.reports).toHaveLength(1);
    expect(reloaded.feedback?.reports[0]?.target.options).toHaveLength(4);
    expect(reloaded.questionProgress?.[step.question.id]?.level).toBe(1);
  }, 30_000);

  it("rejects invalid or oversized state before committing an update", async () => {
    const key = `${prefix}invalid_payload`;
    await store.update(key, () => ({ state: { score: 7 }, result: null }));
    await expect(store.update(key, () => ({ state: { score: undefined }, result: null }))).rejects.toThrow("JSON");
    await expect(store.update(key, () => ({ state: "հ".repeat(900 * 1024 / 2), result: null })))
      .rejects.toThrow("900 KiB UTF-8");
    expect((await store.list(key))[0]?.state).toEqual({ score: 7 });
  });

  it("fails closed on a malformed saved JSON document", async () => {
    const key = `${prefix}corrupt_payload`;
    const reference = db.collection("botState").doc(key);
    const original = { key, version: 1, stateJson: "{invalid" };
    await reference.set(original);
    await expect(store.update(key, () => ({ state: {}, result: null }))).rejects.toThrow("invalid JSON");
    await expect(store.list(key)).rejects.toThrow("invalid JSON");
    expect((await reference.get()).data()).toEqual(original);
  });

  it("pages through more than 1000 real documents without omissions or duplicates", async () => {
    const pagePrefix = `${prefix}page_`;
    const keys = Array.from({ length: 1005 }, (_, index) => `${pagePrefix}${String(index).padStart(4, "0")}`);
    for (let offset = 0; offset < keys.length; offset += 500) {
      const batch = db.batch();
      for (const key of keys.slice(offset, offset + 500)) {
        batch.set(db.collection("botState").doc(key), { key, version: 1, stateJson: JSON.stringify({ saved: true }) });
      }
      await batch.commit();
    }
    const first = await store.listPage(pagePrefix);
    expect(first.records).toHaveLength(100);
    expect(first.nextCursor).toBe(keys[99]);
    const visited: string[] = [];
    let afterKey: string | undefined;
    do {
      const page = await store.listPage(pagePrefix, { afterKey, limit: 201 });
      visited.push(...page.records.map(record => record.key));
      afterKey = page.nextCursor ?? undefined;
    } while (afterKey !== undefined);
    expect(visited).toEqual(keys);
    expect(new Set(visited).size).toBe(1005);
    expect((await store.list(pagePrefix)).map(record => record.key)).toEqual(keys.slice(0, 1000));
    expect(await store.listPage(pagePrefix, { afterKey: keys.at(-1)! })).toEqual({ records: [], nextCursor: null });
    expect((await store.listPage(pagePrefix, { afterKey: `${pagePrefix}0001a`, limit: 1 })).records[0]?.key).toBe(keys[2]);
  }, 30_000);
});
