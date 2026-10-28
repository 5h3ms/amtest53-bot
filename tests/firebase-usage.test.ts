import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'grammy';
import { loadCourse } from '../src/course.js';
import { LearningEngine, type BotEvent, type PendingDelivery, type UserState } from '../src/engine.js';
import { MemoryStateStore } from '../src/storage.js';
import { createTelegramBot, deliverPending } from '../src/telegram.js';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const MINUTE = 60_000;

function user(userId: number): UserState {
  return {
    schema: 1, userId, chatId: userId, createdAt: NOW, updatedAt: NOW,
    session: null, cards: {}, questionMistakes: {}, questionProgress: {},
    completedLessons: [], attempts: 0, correct: 0, exams: [],
    reminders: { enabled: false, time: '19:00', timeZone: 'Asia/Yerevan', lastSentDate: null },
    blocked: false, processedEvents: [], outbox: [],
  };
}

function queued(userId: number, id = `queued_${userId}`, leaseUntil = 0): UserState['outbox'][number] {
  return { id, userId, chatId: userId, view: { text: 'Сохранённый ответ' },
    createdAt: NOW, leaseUntil, expiresAt: null };
}

function fixture(accessMode: 'public' | 'private' = 'public', allowedUserIds: number[] = []) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const store = new MemoryStateStore();
  const engine = new LearningEngine({ store, course: loadCourse(), accessMode, allowedUserIds, adminUserIds: [] });
  const event: BotEvent = { userId: 1, chatId: 1, eventId: 'cost-start', text: '/start', now: NOW };
  const bot = { api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue({ message_id: 42 }),
  } };
  const save = (state: UserState) => store.update(`u_${state.userId}`, () => ({ state, result: undefined }));
  const state = async (userId = 1) => await store.read(`u_${userId}`) as UserState;
  const deliver = (pending: PendingDelivery[]) => deliverPending(bot as unknown as Bot, engine, pending);
  return { store, engine, event, bot, save, state, deliver };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('normal Telegram delivery operation budget', () => {
  it('persists an action and delivery receipt in two updates without a separate claim transaction', async () => {
    const h = fixture();
    const updates = vi.spyOn(h.store, 'update');
    const claim = vi.spyOn(h.engine, 'claim');
    const pending = await h.engine.handle(h.event, true);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.leaseToken).toEqual(expect.any(String));
    expect(pending[0]?.leaseUntil).toBeGreaterThan(NOW);
    await h.deliver(pending);
    expect(h.bot.api.sendMessage).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
    expect(updates).toHaveBeenCalledTimes(2);
    expect((await h.state()).outbox).toEqual([]);
  });

  it('uses reservation in the production Telegram message handler', async () => {
    const h = fixture();
    const updates = vi.spyOn(h.store, 'update');
    const handler = vi.spyOn(h.engine, 'handle');
    const bot = createTelegramBot(`1:${'x'.repeat(24)}`, h.engine);
    bot.botInfo = { id: 900, is_bot: true, first_name: 'Test', username: 'test_bot',
      can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
      allows_users_to_create_topics: false };
    const calls: string[] = [];
    bot.api.config.use(async (_previous, method) => {
      calls.push(method);
      return { ok: true, result: { message_id: 42 } };
    });
    await bot.handleUpdate({ update_id: 1234, message: {
      message_id: 1, date: Math.floor(NOW / 1000), text: '/start',
      from: { id: 1, is_bot: false, first_name: 'Learner' },
      chat: { id: 1, type: 'private', first_name: 'Learner' },
    } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventId: '1234' }), true);
    expect(calls).toEqual(['sendMessage']);
    expect(updates).toHaveBeenCalledTimes(2);
  });

  it('gives concurrent retries of one update a single delivery owner', async () => {
    const h = fixture();
    const results = await Promise.all(Array.from({ length: 5 }, () => h.engine.handle(h.event, true)));
    const deliveries = results.flat();
    expect(deliveries).toHaveLength(1);
    await Promise.all(results.map(pending => h.deliver(pending)));
    expect(h.bot.api.sendMessage).toHaveBeenCalledOnce();
    expect((await h.state()).processedEvents.filter(id => id === h.event.eventId)).toHaveLength(1);
    expect((await h.state()).outbox).toEqual([]);
    await h.deliver(await h.engine.handle(h.event, true));
    expect(h.bot.api.sendMessage).toHaveBeenCalledOnce();
  });

  it('reclaims an expired reservation before sending instead of trusting its old token', async () => {
    const h = fixture();
    const pending = await h.engine.handle(h.event, true);
    const previousToken = pending[0]!.leaseToken!;
    vi.setSystemTime(pending[0]!.leaseUntil! + 1);
    const claim = vi.spyOn(h.engine, 'claim');
    const acknowledge = vi.spyOn(h.engine, 'acknowledge');
    await h.deliver(pending);
    expect(claim).toHaveBeenCalledOnce();
    expect(h.bot.api.sendMessage).toHaveBeenCalledOnce();
    expect(acknowledge.mock.calls[0]?.[2]).toEqual(expect.any(String));
    expect(acknowledge.mock.calls[0]?.[2]).not.toBe(previousToken);
    expect((await h.state()).outbox).toEqual([]);
  });
});

describe('lease ownership and transient failures', () => {
  it('does not let an older sender acknowledge or release a replacement lease', async () => {
    const h = fixture();
    const [pending] = await h.engine.handle(h.event, true);
    expect(pending).toBeDefined();
    const token = pending!.leaseToken!;
    vi.setSystemTime(pending!.leaseUntil! + 1);
    expect(await h.engine.claim(1, pending!.id, 'replacement-token')).toBe(true);
    const replacement = (await h.state()).outbox[0]!;
    await h.engine.acknowledge(1, pending!.id, token);
    await h.engine.release(1, pending!.id, token);
    expect((await h.state()).outbox).toEqual([replacement]);
    await h.engine.acknowledge(1, pending!.id, 'replacement-token');
    expect((await h.state()).outbox).toEqual([]);
  });

  it('does not permit a tokenless completion to erase a token-owned delivery', async () => {
    const h = fixture();
    const [pending] = await h.engine.handle(h.event, true);
    await h.engine.acknowledge(1, pending!.id);
    await h.engine.release(1, pending!.id);
    expect((await h.state()).outbox[0]?.leaseToken).toBe(pending!.leaseToken);
    expect((await h.state()).outbox[0]?.leaseUntil).toBe(pending!.leaseUntil);
  });

  it('retains failed messages and does not retry them before their scheduled retry time', async () => {
    const h = fixture();
    const pending = await h.engine.handle(h.event, true);
    h.bot.api.sendMessage.mockRejectedValueOnce(new Error('temporary network failure'));
    await expect(h.deliver(pending)).rejects.toThrow('Pending messages remain available');
    const retry = (await h.state()).outbox[0]!;
    expect(retry.leaseUntil).toBe(0);
    expect(retry.retryAt).toBe(NOW + MINUTE);
    expect(await h.engine.maintenance(NOW + MINUTE - 1)).toEqual([]);
    vi.setSystemTime(NOW + MINUTE);
    const retryPending = await h.engine.maintenance(NOW + MINUTE);
    expect(retryPending).toHaveLength(1);
    await h.deliver(retryPending);
    expect(h.bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect((await h.state()).outbox).toEqual([]);
  });
});

describe('due-only background maintenance', () => {
  it('fetches only due work among one thousand idle users and never requests a full user scan', async () => {
    const h = fixture();
    await Promise.all(Array.from({ length: 1000 }, (_, index) => h.save(user(index + 1))));
    const due = user(2000); due.outbox.push(queued(2000));
    await h.save(due);
    const busy = user(2001); busy.outbox.push({ ...queued(2001, 'leased', NOW + MINUTE), leaseToken: 'another-worker' });
    await h.save(busy);
    const blocked = user(2002); blocked.blocked = true; blocked.outbox.push(queued(2002));
    await h.save(blocked);
    const scan = vi.spyOn(h.store, 'listPage');
    const legacy = vi.spyOn(h.store, 'list');
    const dueQuery = vi.spyOn(h.store, 'listDuePage');
    const updates = vi.spyOn(h.store, 'update');
    const pending = await h.engine.maintenance(NOW);
    expect(pending.map(item => item.userId)).toEqual([2000]);
    expect(scan).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(dueQuery).toHaveBeenCalledOnce();
    expect((await dueQuery.mock.results[0]!.value).records.map((record: { key: string }) => record.key)).toEqual(['u_2000']);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(pending[0]?.leaseToken).toBeUndefined();
  });

  it('walks equal-time due pages without skipping users as their state changes', async () => {
    const h = fixture();
    await Promise.all(Array.from({ length: 120 }, (_, index) => {
      const state = user(index + 1); state.outbox.push(queued(state.userId));
      return h.save(state);
    }));
    const pending = await h.engine.maintenance(NOW);
    expect(pending).toHaveLength(120);
    expect(new Set(pending.map(item => item.userId)).size).toBe(120);
    await h.deliver(pending);
    expect(await h.engine.maintenance(NOW)).toEqual([]);
  });

  it('does not deliver indexed work for a revoked private participant', async () => {
    const h = fixture('private', [1]);
    const allowed = user(1); allowed.outbox.push(queued(1));
    const revoked = user(2); revoked.outbox.push(queued(2));
    await h.save(allowed); await h.save(revoked);
    const scan = vi.spyOn(h.store, 'listPage');
    const pending = await h.engine.maintenance(NOW);
    expect(pending.map(item => item.userId)).toEqual([1]);
    expect(scan).not.toHaveBeenCalled();
    await h.deliver(pending);
    expect(h.bot.api.sendMessage).toHaveBeenCalledOnce();
    expect((await h.state(2)).outbox).toHaveLength(1);
  });

  it('keeps future exam deadlines out of maintenance and completes them when due', async () => {
    const h = fixture();
    const start = await h.engine.handle({ ...h.event, eventId: 'exam-start', text: undefined, action: 'start:exam' });
    for (const delivery of start) await h.engine.acknowledge(delivery.userId, delivery.id);
    const deadline = (await h.state()).session!.deadlineAt!;
    expect(await h.engine.maintenance(deadline - 1)).toEqual([]);
    vi.setSystemTime(deadline);
    const timeout = await h.engine.maintenance(deadline);
    expect(timeout).toHaveLength(1);
    expect((await h.state()).exams).toHaveLength(1);
    expect((await h.state()).session!.endedAt).toBe(deadline);
    await h.deliver(timeout);
    expect(await h.engine.maintenance(deadline + MINUTE)).toEqual([]);
    expect((await h.state()).exams).toHaveLength(1);
  });
});
