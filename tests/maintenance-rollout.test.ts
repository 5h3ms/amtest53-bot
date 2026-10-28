import { describe, expect, it, vi } from 'vitest';
import { loadCourse } from '../src/course.js';
import { LearningEngine, type UserState } from '../src/engine.js';
import { MemoryStateStore } from '../src/storage.js';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const MARKER = 'meta_maintenance_index_v1';
const course = loadCourse();
function legacyUser(id: number): UserState {
  return {
    schema: 1, userId: id, chatId: id, createdAt: NOW - 1000, updatedAt: NOW - 1000,
    session: null, cards: {}, questionMistakes: {}, completedLessons: [], attempts: 0, correct: 0, exams: [],
    reminders: { enabled: false, time: '19:00', timeZone: 'Asia/Yerevan', lastSentDate: null },
    blocked: false, processedEvents: ['before-deployment'],
    outbox: [{ id: `event_legacy_${id}`, userId: id, chatId: id, view: { text: 'Сохранённый ответ' },
      createdAt: NOW - 1000, expiresAt: null, leaseUntil: 0 }],
  };
}
async function harness() {
  const store = new MemoryStateStore();
  await store.update('u_1', () => ({ state: legacyUser(1), result: null }));
  const makeEngine = () => new LearningEngine({ store, course, accessMode: 'public', allowedUserIds: [], adminUserIds: [],
    requireMaintenanceIndexReady: true });
  const scans = vi.spyOn(store, 'listPage');
  const due = vi.spyOn(store, 'listDuePage');
  const reads = vi.spyOn(store, 'read');
  return { store, makeEngine, scans, due, reads };
}

describe('safe transition to indexed maintenance', () => {
  it('services legacy pending deliveries by the old scan before the verified marker exists', async () => {
    const h = await harness();
    // Models legacy Firestore documents that have no nextMaintenanceAt yet.
    h.due.mockResolvedValue({ records: [], nextCursor: null });
    const pending = await h.makeEngine().maintenance(NOW);
    expect(pending.map(item => item.id)).toEqual(['event_legacy_1']);
    expect(h.scans).toHaveBeenCalledOnce();
    expect(h.due).not.toHaveBeenCalled();
    expect(h.reads).toHaveBeenCalledWith(MARKER);
    expect((await h.store.read('u_1') as UserState).processedEvents).toEqual(['before-deployment']);
  });

  it('uses only the due query after readiness, including on a new instance', async () => {
    const h = await harness();
    await h.store.update(MARKER, () => ({ state: { ready: true, version: 1 }, result: null }));
    const engine = h.makeEngine();
    expect((await engine.maintenance(NOW)).map(item => item.id)).toEqual(['event_legacy_1']);
    expect((await engine.maintenance(NOW + 1000)).map(item => item.id)).toEqual(['event_legacy_1']);
    expect((await h.makeEngine().maintenance(NOW + 2000)).map(item => item.id)).toEqual(['event_legacy_1']);
    expect(h.scans).not.toHaveBeenCalled();
    expect(h.due).toHaveBeenCalledTimes(3);
    expect(h.reads.mock.calls.filter(([key]) => key === MARKER)).toHaveLength(3);
  });

  it('returns a warm instance to the legacy scan when rollout readiness is revoked', async () => {
    const h = await harness(), engine = h.makeEngine();
    await h.store.update(MARKER, () => ({ state: { ready: true }, result: null }));
    await engine.maintenance(NOW);
    h.due.mockClear();
    await h.store.update(MARKER, () => ({ state: { ready: false }, result: null }));
    const pending = await engine.maintenance(NOW + 1000);
    expect(pending.map(item => item.id)).toEqual(['event_legacy_1']);
    expect(h.scans).toHaveBeenCalledOnce();
    expect(h.due).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ready: false }, { ready: 'true' }, { ready: 1 }, [], 'ready'])('does not trust invalid readiness marker %j', async marker => {
    const h = await harness();
    await h.store.update(MARKER, () => ({ state: marker, result: null }));
    const pending = await h.makeEngine().maintenance(NOW);
    expect(pending.map(item => item.id)).toEqual(['event_legacy_1']);
    expect(h.scans).toHaveBeenCalledOnce();
    expect(h.due).not.toHaveBeenCalled();
  });

  it('keeps private access revocation effective during fallback scanning', async () => {
    const h = await harness();
    const privateEngine = new LearningEngine({ store: h.store, course, accessMode: 'private', allowedUserIds: [2], adminUserIds: [],
      requireMaintenanceIndexReady: true });
    expect(await privateEngine.maintenance(NOW)).toEqual([]);
    expect((await h.store.read('u_1') as UserState).outbox).toHaveLength(1);
  });
});
