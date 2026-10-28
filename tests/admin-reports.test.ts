import { describe, expect, it, vi } from 'vitest';
import { AdminReports, ADMIN_CACHE_TTL_MS } from '../src/admin-reports.js';
import { recordUsage } from '../src/analytics.js';
import { loadCourse } from '../src/course.js';
import type { MessageView, UserState } from '../src/engine.js';
import { MemoryStateStore } from '../src/storage.js';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const course = loadCourse();
function user(id: number, options: { questionId?: string; report?: boolean; correct?: boolean } = {}): UserState {
  let analytics = recordUsage(undefined, { kind: 'active' }, NOW - 1000);
  analytics = recordUsage(analytics, { kind: 'answer', selected: options.correct === false ? 1 : 0, correct: options.correct !== false, hinted: false,
    question: { id: options.questionId ?? 'q001', version: course.version, prompt: 'Учебный вопрос', options: ['А', 'Б', 'В', 'Г'], correctIndex: 0 } }, NOW - 1000);
  return { schema: 1, userId: id, chatId: id, createdAt: NOW - 1000, updatedAt: NOW - 1000,
    session: null, cards: {}, questionMistakes: {}, questionProgress: {}, completedLessons: [], attempts: 1, correct: 1, exams: [], analytics,
    feedback: { reports: options.report ? [{ id: `report-${id}`, at: NOW - id, category: 'ambiguous', description: `Описание ${id}`,
      target: { kind: 'question', id: 'q001', contentVersion: course.version, prompt: 'Հարց', options: ['ա', 'բ', 'գ', 'դ'] } }] : [] },
    reminders: { enabled: false, time: '19:00', timeZone: 'Asia/Yerevan', lastSentDate: null }, blocked: false, processedEvents: [], outbox: [] };
}
async function seed(store: MemoryStateStore, count: number, options: Parameters<typeof user>[1] = {}): Promise<void> {
  for (let id = 1; id <= count; id++) await store.update(`u_${id}`, () => ({ state: user(id, options), result: undefined }));
}
const action = (view: MessageView, starts: string): string => {
  const data = view.buttons?.flat().find(button => button.data.startsWith(starts))?.data;
  if (!data) throw new Error(`Missing button ${starts}`);
  return data;
};
const ids = (view: MessageView): number[] => [...view.text.matchAll(/\bID (\d+)/g)].map(match => Number(match[1]));

describe('durable administrator report cache', () => {
  it('scans once and shares the cached result across pages and service instances', async () => {
    const store = new MemoryStateStore(); await seed(store, 205, { report: true });
    const service = new AdminReports({ store, course });
    const pages = vi.spyOn(store, 'listPage');
    const stats = await service.view('admin:stats', NOW);
    expect(stats.text).toContain('Пользователей: 205');
    expect(stats.text).toContain('205/205');
    expect(stats.text).toContain('Сводка обновлена: 2026-10-29 10:00 UTC');
    expect(pages.mock.calls.filter(([prefix]) => prefix === 'u_')).toHaveLength(3);
    pages.mockClear();
    const restarted = new AdminReports({ store, course });
    const choices = await restarted.view('admin:questions:0', NOW + 1000);
    expect(choices.text).toContain('Ответов: 205');
    expect(choices.text).toContain('Б: 0/205');
    const reports = await restarted.view('admin:reports:1', NOW + 2000);
    expect(reports.text).toContain('Описание 2');
    expect(reports.text).toContain('Сообщение об ошибке 2/205');
    await restarted.view('admin:stats', NOW + 3000);
    expect(pages).not.toHaveBeenCalled();
  });

  it('refreshes at TTL, keeps new observations out of the old snapshot, and removes retired chunks', async () => {
    const store = new MemoryStateStore(); await seed(store, 1, { report: true });
    const service = new AdminReports({ store, course });
    await service.view('admin:stats', NOW);
    const oldChunks = (await store.list('admin_cache_v1_g_')).map(record => record.key);
    await store.update('u_2', () => ({ state: user(2), result: undefined }));
    expect((await service.view('admin:stats', NOW + ADMIN_CACHE_TTL_MS - 1)).text).toContain('Пользователей: 1');
    expect((await service.view('admin:stats', NOW + ADMIN_CACHE_TTL_MS)).text).toContain('Пользователей: 2');
    const current = (await store.list('admin_cache_v1_g_')).map(record => record.key);
    expect(current.length).toBe(2);
    expect(current.some(key => oldChunks.includes(key))).toBe(false);
  });

  it('invalidates cached results when course version changes', async () => {
    const store = new MemoryStateStore(); await seed(store, 1);
    await new AdminReports({ store, course }).view('admin:stats', NOW);
    await store.update('u_2', () => ({ state: user(2), result: undefined }));
    const newer = new AdminReports({ store, course: { ...course, version: `${course.version}.next` } });
    expect((await newer.view('admin:stats', NOW + 1)).text).toContain('Пользователей: 2');
  });

  it('includes a new requesting owner once, while keeping newer stored state authoritative', async () => {
    const store = new MemoryStateStore(); await seed(store, 1);
    const service = new AdminReports({ store, course });
    expect((await service.view('admin:stats', NOW, user(2))).text).toContain('Пользователей: 2');
    const stale = user(1); stale.analytics = undefined;
    const refreshed = await service.view('admin:stats', NOW + ADMIN_CACHE_TTL_MS, stale);
    expect(refreshed.text).toContain('Пользователей: 1');
    expect(refreshed.text).toContain('100% (1/1)');
  });

  it('retains the last successful snapshot when refresh fails', async () => {
    const store = new MemoryStateStore(); await seed(store, 2);
    const service = new AdminReports({ store, course });
    await service.view('admin:stats', NOW);
    const original = store.listPage.bind(store);
    vi.spyOn(store, 'listPage').mockImplementation((prefix, options) => prefix === 'u_' ? Promise.reject(new Error('read unavailable')) : original(prefix, options));
    const response = await service.view('admin:stats', NOW + ADMIN_CACHE_TTL_MS);
    expect(response.text).toContain('Пользователей: 2');
    expect(response.text).toContain('последняя успешно собранная сводка');
    expect((await store.read('admin_cache_v1') as { lease: unknown }).lease).toBeNull();
  });

  it('backs off a failed initial scan instead of retrying it on every owner click', async () => {
    const store = new MemoryStateStore(); await seed(store, 1);
    const service = new AdminReports({ store, course }), original = store.listPage.bind(store);
    let unavailable = true;
    const scan = vi.spyOn(store, 'listPage').mockImplementation((prefix, options) =>
      unavailable && prefix === 'u_' ? Promise.reject(new Error('temporarily unavailable')) : original(prefix, options));
    expect((await service.view('admin:stats', NOW)).text).toContain('Сводка обновляется');
    unavailable = false;
    await service.view('admin:stats', NOW + 1000);
    await service.view('admin:reports:0', NOW + 59_999);
    expect(scan.mock.calls.filter(([prefix]) => prefix === 'u_')).toHaveLength(1);
    expect((await service.view('admin:stats', NOW + 60_000)).text).toContain('Пользователей: 1');
  });

  it('allows only one concurrent refresh and serves a busy view until its initial publication', async () => {
    const store = new MemoryStateStore(); await seed(store, 1);
    const original = store.listPage.bind(store);
    let release!: () => void, scanned!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { scanned = resolve; });
    const scan = vi.spyOn(store, 'listPage').mockImplementation(async (prefix, options) => {
      if (prefix === 'u_') { scanned(); await gate; }
      return original(prefix, options);
    });
    const first = new AdminReports({ store, course }).view('admin:stats', NOW);
    await started;
    const second = await new AdminReports({ store, course }).view('admin:stats', NOW);
    expect(second.text).toContain('Сводка обновляется');
    release();
    expect((await first).text).toContain('Пользователей: 1');
    expect(scan.mock.calls.filter(([prefix]) => prefix === 'u_')).toHaveLength(1);
  });

  it('fences a stalled chunk writer after another instance takes over its expired lease', async () => {
    const store = new MemoryStateStore(); await seed(store, 1, { report: true });
    const original = store.update.bind(store);
    let release!: () => void, writing!: () => void, stalled = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { writing = resolve; });
    vi.spyOn(store, 'update').mockImplementation(async (key, fn, guard) => {
      if (!stalled && key.startsWith('admin_cache_v1_g_')) { stalled = true; writing(); await gate; }
      return original(key, fn, guard);
    });
    const first = new AdminReports({ store, course }).view('admin:stats', NOW);
    await started;
    const successor = await new AdminReports({ store, course }).view('admin:stats', NOW + 60_001);
    expect(successor.text).toContain('Пользователей: 1');
    const published = await store.read('admin_cache_v1') as { snapshot: { generation: string } };
    release();
    expect((await first).text).toContain('Пользователей: 1');
    const chunks = await store.list('admin_cache_v1_g_');
    expect(chunks).toHaveLength(2);
    expect(chunks.every(chunk => chunk.key.includes(published.snapshot.generation))).toBe(true);
    expect((await store.read('admin_cache_v1') as { snapshot: { generation: string } }).snapshot.generation).toBe(published.snapshot.generation);
  });

  it('stops after a slow scan consumes the entire refresh budget and recovers on a later lease', async () => {
    const store = new MemoryStateStore(); await seed(store, 1);
    const service = new AdminReports({ store, course }), original = store.listPage.bind(store);
    let wall = 1_000, delayed = false;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    try {
      vi.spyOn(store, 'listPage').mockImplementation(async (prefix, options) => {
        const result = await original(prefix, options);
        if (prefix === 'u_' && !delayed) { delayed = true; wall += 20_001; }
        return result;
      });
      expect((await service.view('admin:stats', NOW)).text).toContain('Сводка обновляется');
      expect(await store.list('admin_cache_v1_g_')).toEqual([]);
      expect((await service.view('admin:stats', NOW + 60_001)).text).toContain('Пользователей: 1');
    } finally { clock.mockRestore(); }
  });

  it('keeps cached documents bounded and preserves all questions and report references', async () => {
    const store = new MemoryStateStore();
    for (let id = 1; id <= 225; id++) await store.update(`u_${id}`, () => ({ state: user(id, { questionId: `q${id}`, report: true }), result: undefined }));
    const service = new AdminReports({ store, course });
    const stats = await service.view('admin:stats', NOW);
    expect(stats.text).toContain('Пользователей: 225');
    const question = await service.view('admin:questions:224', NOW);
    const report = await service.view('admin:reports:224', NOW);
    expect(question.text).toContain('225/225'); expect(report.text).toContain('Описание 225');
    const chunks = await store.list('admin_cache_v1_g_');
    expect(chunks).toHaveLength(6);
    for (const chunk of chunks) expect(Buffer.byteLength(JSON.stringify(chunk.state))).toBeLessThan(800 * 1024);
    for (const view of [stats, question, report]) {
      expect(view.text.length).toBeLessThan(4096);
      for (const button of view.buttons?.flat() ?? []) expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
    }
  });

  it('loads only the selected report user and respects deleted reports without a full rescan', async () => {
    const store = new MemoryStateStore(); await seed(store, 2, { report: true });
    const service = new AdminReports({ store, course }); await service.view('admin:stats', NOW);
    await store.delete('u_1');
    const scan = vi.spyOn(store, 'listPage'), reads = vi.spyOn(store, 'read');
    const response = await service.view('admin:reports:0', NOW + 1);
    expect(response.text).toContain('больше не хранится');
    expect(reads.mock.calls.filter(([key]) => key.startsWith('u_'))).toEqual([['u_1']]);
    expect(scan).not.toHaveBeenCalled();
  });

  it('recovers from a published generation being retired between its manifest and chunk reads', async () => {
    const store = new MemoryStateStore(); await seed(store, 1);
    const service = new AdminReports({ store, course }); await service.view('admin:stats', NOW);
    const original = store.read.bind(store); let swapped = false;
    vi.spyOn(store, 'read').mockImplementation(async key => {
      if (!swapped && key.startsWith('admin_cache_v1_g_')) {
        swapped = true;
        await new AdminReports({ store, course }).view('admin:stats', NOW + ADMIN_CACHE_TTL_MS);
      }
      return original(key);
    });
    expect((await service.view('admin:questions:0', NOW + 1)).text).toContain('Выбор вариантов · 1/1');
  });
});

describe('direct user pagination', () => {
  it('reads five users at a time in both directions without building any summary', async () => {
    const store = new MemoryStateStore(); await seed(store, 23);
    const service = new AdminReports({ store, course }), pages = vi.spyOn(store, 'listPage'), read = vi.spyOn(store, 'read');
    const first = await service.view('admin:users:0', NOW);
    const second = await service.view(action(first, 'admin:users:a:'), NOW);
    const third = await service.view(action(second, 'admin:users:a:'), NOW);
    const back = await service.view(action(third, 'admin:users:b:'), NOW);
    expect(ids(first)).toHaveLength(5); expect(ids(second)).toHaveLength(5); expect(ids(third)).toHaveLength(5);
    expect(ids(back)).toEqual(ids(second));
    expect(new Set([...ids(first), ...ids(second), ...ids(third)]).size).toBe(15);
    expect(pages).toHaveBeenCalledTimes(4);
    expect(pages.mock.calls.every(([prefix, options]) => prefix === 'u_' && options?.limit === 5)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(await store.read('admin_cache_v1')).toBeNull();
    for (const button of third.buttons?.flat() ?? []) expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
  });

  it('treats malformed or forged cursors as the first user page', async () => {
    const store = new MemoryStateStore(); await seed(store, 2);
    const service = new AdminReports({ store, course });
    expect(ids(await service.view('admin:users:a:admin_cache_v1', NOW))).toEqual([1, 2]);
    expect(ids(await service.view('admin:users:b:u_9999999999999999', NOW))).toEqual([1, 2]);
  });
});
