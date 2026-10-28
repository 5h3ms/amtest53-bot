import { describe, expect, it } from 'vitest';
import { deriveMaintenanceIndex, nextReminderAt } from '../src/maintenance-index.js';

const at = (text: string) => Date.parse(text);
const user = () => ({ schema: 1, userId: 42, chatId: 42, blocked: false,
  session: null as null | { kind: string; endedAt: number | null; deadlineAt: number },
  reminders: { enabled: false, time: '19:00', timeZone: 'Asia/Yerevan', lastSentDate: null as string | null },
  outbox: [] as Array<{ id: string; userId: number; chatId: number; createdAt: number; leaseUntil: number; retryAt?: number; expiresAt: number | null }>,
});

describe('maintenance scheduling metadata', () => {
  it('does not schedule idle, blocked, non-user or identity-mismatched records', () => {
    const state = user(), now = at('2026-10-29T10:00:00Z');
    expect(deriveMaintenanceIndex(state, 'u_42', now)).toBeNull();
    expect(deriveMaintenanceIndex(state, 'cache_stats', now)).toBeNull();
    expect(deriveMaintenanceIndex(state, 'u_41', now)).toBeNull();
    expect(deriveMaintenanceIndex(null, 'u_42', now)).toBeNull();
    state.session = { kind: 'exam', endedAt: null, deadlineAt: now - 1 };
    state.blocked = true;
    expect(deriveMaintenanceIndex(state, 'u_42', now)).toBeNull();
  });

  it('selects the earliest exam deadline, lease expiry or retry time', () => {
    const state = user(), now = at('2026-10-29T10:00:00Z');
    state.session = { kind: 'exam', endedAt: null, deadlineAt: now + 60_000 };
    state.outbox = [{ id: 'event_1', userId: 42, chatId: 42, createdAt: now - 20_000, leaseUntil: now + 30_000, expiresAt: null }];
    expect(deriveMaintenanceIndex(state, 'u_42', now)).toBe(now + 30_000);
    state.outbox[0]!.retryAt = now + 90_000;
    expect(deriveMaintenanceIndex(state, 'u_42', now)).toBe(now + 60_000);
    state.session.endedAt = now;
    expect(deriveMaintenanceIndex(state, 'u_42', now)).toBe(now + 90_000);
  });

  it('keeps available outbox times stable for no-op transactions and schedules expiration cleanup', () => {
    const state = user(), now = at('2026-10-29T10:00:00Z');
    state.outbox = [{ id: 'event_1', userId: 42, chatId: 42, createdAt: now - 1000, leaseUntil: 0, expiresAt: null }];
    expect(deriveMaintenanceIndex(state, 'u_42', now)).toBe(now - 1000);
    expect(deriveMaintenanceIndex(state, 'u_42', now + 100)).toBe(now - 1000);
    state.reminders.enabled = true;
    state.outbox[0] = { ...state.outbox[0]!, id: 'reminder_2026-10-29', leaseUntil: now + 60_000, expiresAt: now - 500 };
    expect(deriveMaintenanceIndex(state, 'u_42', now)).toBe(now - 500);
    state.reminders.enabled = false;
    expect(deriveMaintenanceIndex(state, 'u_42', now)).toBe(now - 1000);
  });

  it('rejects non-finite time and tolerates malformed legacy settings', () => {
    expect(() => deriveMaintenanceIndex(user(), 'u_42', NaN)).toThrow('maintenance time');
    expect(nextReminderAt({ enabled: true, time: '99:99', timeZone: 'UTC' }, Date.now())).toBeNull();
    expect(nextReminderAt({ enabled: true, time: '19:00', timeZone: 'Not/AZone' }, Date.now())).toBeNull();
  });
});

describe('daily reminders and time zones', () => {
  it('matches the existing ten-minute window and advances after it or after sending', () => {
    const reminders = { enabled: true, time: '19:00', timeZone: 'Asia/Yerevan', lastSentDate: null as string | null };
    const scheduled = at('2026-10-29T15:00:00Z');
    expect(nextReminderAt(reminders, scheduled - 1)).toBe(scheduled);
    expect(nextReminderAt(reminders, scheduled + 9 * 60_000 + 59_999)).toBe(scheduled);
    expect(nextReminderAt(reminders, scheduled + 10 * 60_000)).toBe(scheduled + 86_400_000);
    reminders.lastSentDate = '2026-10-29';
    expect(nextReminderAt(reminders, scheduled + 1)).toBe(scheduled + 86_400_000);
  });

  it('recognizes a reminder window crossing local midnight', () => {
    const reminders = { enabled: true, time: '23:58', timeZone: 'Asia/Yerevan', lastSentDate: null as string | null };
    expect(nextReminderAt(reminders, at('2026-10-29T20:03:00Z'))).toBe(at('2026-10-29T19:58:00Z'));
    reminders.lastSentDate = '2026-10-29';
    expect(nextReminderAt(reminders, at('2026-10-29T20:03:00Z'))).toBe(at('2026-10-30T19:58:00Z'));
  });

  it('uses the correct UTC offset before and after spring DST, skipping a nonexistent local time', () => {
    const reminders = { enabled: true, time: '02:30', timeZone: 'America/New_York', lastSentDate: null };
    expect(nextReminderAt(reminders, at('2026-03-07T08:00:00Z'))).toBe(at('2026-03-09T06:30:00Z'));
    expect(nextReminderAt({ ...reminders, time: '03:30' }, at('2026-03-07T09:00:00Z'))).toBe(at('2026-03-08T07:30:00Z'));
  });

  it('handles both fall DST occurrences but never sends twice on the same local date', () => {
    const reminders = { enabled: true, time: '01:30', timeZone: 'America/New_York', lastSentDate: null as string | null };
    expect(nextReminderAt(reminders, at('2026-11-01T05:00:00Z'))).toBe(at('2026-11-01T05:30:00Z'));
    expect(nextReminderAt(reminders, at('2026-11-01T06:00:00Z'))).toBe(at('2026-11-01T06:30:00Z'));
    reminders.lastSentDate = '2026-11-01';
    expect(nextReminderAt(reminders, at('2026-11-01T06:00:00Z'))).toBe(at('2026-11-02T06:30:00Z'));
  });

  it('supports half-hour daylight saving transitions', () => {
    const reminders = { enabled: true, time: '02:15', timeZone: 'Australia/Lord_Howe', lastSentDate: null };
    expect(nextReminderAt(reminders, at('2026-10-03T00:00:00Z'))).toBe(at('2026-10-04T15:15:00Z'));
  });
});
