import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { backfillMaintenanceIndex, MAINTENANCE_READY_KEY } from '../src/maintenance-migration.js';
import { deriveMaintenanceIndex } from '../src/maintenance-index.js';

const NOW = Date.parse('2026-10-29T10:00:00Z');
type Document = Record<string, unknown>;
type Operation = { key: string; data: Document; kind: 'set' | 'update' };

function state(id: number, pending = false): Document {
  return { schema: 1, userId: id, chatId: id, createdAt: NOW, updatedAt: NOW,
    session: null, cards: { v001: { level: 1, seen: 1, mistakes: 0, dueAt: NOW + 86_400_000 } },
    questionMistakes: {}, questionProgress: {}, completedLessons: ['l001'], attempts: 1, correct: 1,
    exams: [], processedEvents: ['previous-event'], blocked: false,
    reminders: { enabled: false, time: '19:00', timeZone: 'Asia/Yerevan', lastSentDate: null },
    outbox: pending ? [{ id: 'queued', userId: id, chatId: id, view: { text: 'Сохранённый ответ' },
      createdAt: NOW, leaseUntil: 0, expiresAt: null }] : [],
  };
}
function envelope(id: number, value = state(id)): Document {
  return { key: `u_${id}`, version: 1, stateJson: JSON.stringify(value, null, 2), unrelated: 'preserve me' };
}

/** Small transactional fake: patches and sets commit only after callback completion. */
function database(initial: Record<string, Document>) {
  const records = new Map(Object.entries(structuredClone(initial)));
  const committed: Operation[] = [];
  const queries: Array<{ due: boolean; after: unknown[]; limit: number }> = [];
  let beforeGet: ((key: string) => void) | undefined;
  let onQuery: ((due: boolean) => void) | undefined;
  let retryOnce = false;
  let dueQueryFails = false;
  const reference = (key: string) => ({ id: key,
    get: async () => snapshot(key),
  });
  const snapshot = (key: string) => ({ id: key, ref: reference(key), exists: records.has(key),
    data: () => records.has(key) ? structuredClone(records.get(key)!) : undefined,
  });
  const fieldName = (field: unknown) => typeof field === 'string' ? field : '__name__';
  function query(filters: Array<[string, string, unknown]> = [], orders: string[] = [], after: unknown[] = [], limit = Infinity) {
    return {
      doc: (key: string) => reference(key),
      where: (field: unknown, operator: string, value: unknown) => query([...filters, [fieldName(field), operator, value]], orders, after, limit),
      orderBy: (field: unknown) => query(filters, [...orders, fieldName(field)], after, limit),
      startAfter: (...values: unknown[]) => query(filters, orders, values, limit),
      limit: (next: number) => query(filters, orders, after, next),
      get: async () => {
        const due = filters.some(([field]) => field === 'nextMaintenanceAt');
        queries.push({ due, after, limit });
        onQuery?.(due);
        if (due && dueQueryFails) throw new Error('Index not ready');
        const values = (key: string) => (orders.length ? orders : ['__name__'])
          .map(field => field === '__name__' ? key : records.get(key)?.[field]);
        const compare = (left: unknown[], right: unknown[]) => {
          for (let index = 0; index < left.length; index++) {
            if (left[index] === right[index]) continue;
            return (left[index] as number | string) < (right[index] as number | string) ? -1 : 1;
          }
          return 0;
        };
        const keys = [...records.keys()].filter(key => filters.every(([field, operator, threshold]) => {
          const value = field === '__name__' ? key : records.get(key)?.[field];
          if (typeof value !== typeof threshold) return false;
          return operator === '>=' ? (value as string) >= (threshold as string) : (value as string) <= (threshold as string);
        })).sort((a, b) => compare(values(a), values(b))).filter(key => !after.length || compare(values(key), after) > 0).slice(0, limit);
        // Query data is a snapshot; transaction reads may see a concurrent replacement.
        const docs = keys.map(key => {
          const data = structuredClone(records.get(key)!);
          return { ...snapshot(key), data: () => structuredClone(data) };
        });
        return { docs };
      },
    };
  }
  const db = {
    collection: (name: string) => { if (name !== 'botState') throw new Error('Wrong collection'); return query(); },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      let pending: Operation[] = [];
      const tx = {
        get: async (ref: { id: string }) => { beforeGet?.(ref.id); return snapshot(ref.id); },
        set: (ref: { id: string }, data: Document) => { pending.push({ key: ref.id, data: structuredClone(data), kind: 'set' }); },
        update: (ref: { id: string }, data: Document) => { pending.push({ key: ref.id, data: structuredClone(data), kind: 'update' }); },
      };
      let result = await fn(tx);
      if (retryOnce && pending.some(operation => operation.key.startsWith('u_'))) {
        retryOnce = false; pending = []; result = await fn(tx);
      }
      for (const operation of pending) {
        if (operation.kind === 'update' && !records.has(operation.key)) throw new Error('Document removed');
        records.set(operation.key, operation.kind === 'set' ? operation.data : { ...records.get(operation.key), ...operation.data });
        committed.push(operation);
      }
      return result;
    },
  } as unknown as Firestore;
  return { db, records, committed, queries,
    beforeGet(callback: (key: string) => void) { beforeGet = callback; },
    onQuery(callback: (due: boolean) => void) { onQuery = callback; },
    retry() { retryOnce = true; },
    failDueQuery() { dueQueryFails = true; },
    ready() {
      const marker = records.get(MAINTENANCE_READY_KEY);
      return marker ? JSON.parse(marker.stateJson as string).ready : undefined;
    },
  };
}

describe('one-time maintenance index migration', () => {
  it('defaults to a read-only decision when apply is false, including the readiness marker', async () => {
    const h = database({ u_1: envelope(1), u_2: envelope(2, state(2, true)) });
    const before = structuredClone(h.records);
    const result = await backfillMaintenanceIndex(h.db, { apply: false, now: NOW });
    expect(result).toMatchObject({ apply: false, scanned: 2, updated: 2, invalid: 0, readyPublished: false });
    expect(h.records).toEqual(before);
    expect(h.committed).toEqual([]);
    expect(h.ready()).toBeUndefined();
  });

  it('patches only scheduling metadata and preserves the exact saved JSON and unrelated fields', async () => {
    const first = envelope(1), second = envelope(2, state(2, true));
    const h = database({ u_1: first, u_2: second, cache_other: { key: 'cache_other', version: 1, stateJson: '{}' } });
    const result = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(result).toMatchObject({ scanned: 2, updated: 2, verified: 2, invalid: 0, verificationMissing: 0, readyPublished: true });
    expect(h.records.get('u_1')).toEqual({ ...first, maintenanceIndexVersion: 1, nextMaintenanceAt: null });
    expect(h.records.get('u_2')).toEqual({ ...second, maintenanceIndexVersion: 1, nextMaintenanceAt: NOW });
    for (const write of h.committed.filter(operation => operation.key.startsWith('u_'))) {
      expect(write.kind).toBe('update');
      expect(Object.keys(write.data).sort()).toEqual(['maintenanceIndexVersion', 'nextMaintenanceAt']);
    }
    expect(h.queries.filter(query => query.due)).toHaveLength(1);
    expect(h.ready()).toBe(true);
  });

  it('is idempotent for user documents and counts a retried transaction only once', async () => {
    const h = database({ u_1: envelope(1, state(1, true)) });
    h.retry();
    const first = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(first.updated).toBe(1);
    const before = h.committed.filter(operation => operation.key.startsWith('u_')).length;
    const second = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(second).toMatchObject({ updated: 0, unchanged: 1, readyPublished: true });
    expect(h.committed.filter(operation => operation.key.startsWith('u_'))).toHaveLength(before);
  });

  it('re-reads a concurrently changed user and never writes the old state snapshot back', async () => {
    const h = database({ u_1: envelope(1, state(1, true)) });
    const concurrent = { ...state(1), attempts: 87, correct: 70, completedLessons: ['l001', 'l002'] };
    let changed = false;
    h.beforeGet(key => {
      if (key !== 'u_1' || changed) return;
      changed = true; h.records.set(key, envelope(1, concurrent));
    });
    const result = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(result.readyPublished).toBe(true);
    expect(h.records.get('u_1')?.stateJson).toBe(JSON.stringify(concurrent, null, 2));
    expect(h.records.get('u_1')?.nextMaintenanceAt).toBeNull();
  });

  it.each([
    { version: 2 },
    { stateJson: '{invalid JSON' },
    { stateJson: JSON.stringify({ ...state(1), completedLessons: null }) },
    { stateJson: JSON.stringify({ ...state(1), processedEvents: undefined }) },
    { stateJson: JSON.stringify({ ...state(1), reminders: { enabled: true, time: '19:00', timeZone: 'invalid-zone' } }) },
    { stateJson: JSON.stringify({ ...state(1), outbox: [{ ...((state(1, true).outbox as Document[])[0]), chatId: 999 }] }) },
  ])('does not enable readiness for malformed user data %j', async invalid => {
    const h = database({ u_1: { ...envelope(1), ...invalid },
      [MAINTENANCE_READY_KEY]: { key: MAINTENANCE_READY_KEY, version: 1, stateJson: '{"ready":true,"version":1}' } });
    const before = h.records.get('u_1')?.stateJson;
    const result = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(result).toMatchObject({ invalid: 1, verificationInvalid: 1, readyPublished: false });
    expect(h.ready()).toBe(false);
    expect(h.records.get('u_1')?.stateJson).toBe(before);
    expect(h.committed.some(operation => operation.key === 'u_1')).toBe(false);
  });

  it('does not recreate a document deleted between listing and transaction read', async () => {
    const h = database({ u_1: envelope(1) });
    h.beforeGet(key => { if (key === 'u_1') h.records.delete(key); });
    const result = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(result).toMatchObject({ missing: 1, readyPublished: false });
    expect(h.records.has('u_1')).toBe(false);
    expect(h.ready()).toBe(false);
  });

  it('blocks activation when verification finds a new user without scheduling metadata', async () => {
    const h = database({ u_2: envelope(2) });
    let userQueries = 0;
    h.onQuery(due => {
      if (!due && ++userQueries === 2) h.records.set('u_1', envelope(1, state(1, true)));
    });
    const result = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(result).toMatchObject({ verified: 2, verificationMissing: 1, readyPublished: false });
    expect(h.ready()).toBe(false);
  });

  it('accepts valid concurrent metadata timestamps instead of requiring snapshot equality', async () => {
    const h = database({ u_1: envelope(1, state(1, true)) });
    let userQueries = 0;
    h.onQuery(due => {
      if (!due && ++userQueries === 2) {
        const replacement = state(1, true);
        (replacement.outbox as Document[])[0]!.leaseUntil = NOW + 60_000;
        h.records.set('u_1', { ...envelope(1, replacement), maintenanceIndexVersion: 1,
          nextMaintenanceAt: deriveMaintenanceIndex(replacement, 'u_1', NOW + 1) });
      }
    });
    const result = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(result).toMatchObject({ verificationMissing: 0, readyPublished: true });
  });

  it('keeps readiness disabled if the production due query is not usable', async () => {
    const h = database({ u_1: envelope(1) });
    h.failDueQuery();
    await expect(backfillMaintenanceIndex(h.db, { apply: true, now: NOW })).rejects.toThrow('Index not ready');
    expect(h.ready()).toBe(false);
  });

  it('processes more than one page without skipping any user', async () => {
    const h = database(Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`u_${index + 1}`, envelope(index + 1)])));
    const result = await backfillMaintenanceIndex(h.db, { apply: true, now: NOW });
    expect(result).toMatchObject({ scanned: 205, updated: 205, verified: 205, readyPublished: true });
    expect(h.committed.filter(operation => operation.key.startsWith('u_'))).toHaveLength(205);
  });
});
