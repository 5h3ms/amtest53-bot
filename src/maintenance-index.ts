/** Scheduling metadata is derived from the saved state, never from a second write. */
export const MAINTENANCE_INDEX_VERSION = 1;
const MINUTE = 60_000;
const DAY = 86_400_000;
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 256) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, format);
  }
  return format;
}

function localParts(now: number, format: Intl.DateTimeFormat): { date: string; time: string; wall: number } {
  const values = Object.fromEntries(format.formatToParts(now).map(part => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  const time = `${values.hour}:${values.minute}`;
  return { date, time, wall: Date.parse(`${date}T${time}:${values.second}Z`) };
}

/** Invalid/non-user records must never enter the scheduled-user query. */
export function isMaintenanceUser(state: unknown, key: string): state is JsonRecord {
  return record(state) && state.schema === 1 && Number.isSafeInteger(state.userId) && (state.userId as number) > 0 &&
    key === `u_${state.userId}` && state.chatId === state.userId && typeof state.blocked === 'boolean' &&
    Array.isArray(state.outbox) && record(state.reminders);
}

/**
 * Resolve wall-clock reminder times against offsets on both sides of a DST transition.
 * Nonexistent local times are skipped; ambiguous times are sent at most once per local date.
 */
export function nextReminderAt(reminders: unknown, now: number): number | null {
  if (!record(reminders) || reminders.enabled !== true || typeof reminders.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(reminders.time) || typeof reminders.timeZone !== 'string') return null;
  try {
    const format = formatter(reminders.timeZone);
    const today = localParts(now, format).date;
    const offsets = new Set<number>();
    // Covers yesterday's window across midnight plus the next local days, including date-line changes.
    for (const hours of [-48, -24, 0, 24, 48, 72, 96]) {
      const sample = Math.floor((now + hours * 3_600_000) / 1000) * 1000;
      offsets.add(localParts(sample, format).wall - sample);
    }
    const candidates: number[] = [];
    for (let day = -1; day <= 3; day++) {
      const date = new Date(Date.parse(`${today}T12:00:00Z`) + day * DAY).toISOString().slice(0, 10);
      if (date === reminders.lastSentDate) continue;
      const target = Date.parse(`${date}T${reminders.time}:00Z`);
      for (const offset of offsets) {
        const instant = target - offset;
        if (instant + 10 * MINUTE <= now) continue;
        const local = localParts(instant, format);
        if (local.date === date && local.time === reminders.time) candidates.push(instant);
      }
    }
    return candidates.length ? Math.min(...candidates) : null;
  } catch {
    return null;
  }
}

/** Earliest outstanding event; null means no scheduled work. */
export function deriveMaintenanceIndex(state: unknown, key: string, now: number): number | null {
  if (!timestamp(now)) throw new Error('Invalid maintenance time');
  if (!isMaintenanceUser(state, key) || state.blocked) return null;
  const due: number[] = [];
  const session = state.session;
  if (record(session) && session.kind === 'exam' && session.endedAt === null && timestamp(session.deadlineAt)) {
    due.push(session.deadlineAt);
  }
  const reminders = state.reminders as JsonRecord;
  for (const candidate of state.outbox as unknown[]) {
    if (!record(candidate) || typeof candidate.id !== 'string' || candidate.userId !== state.userId || candidate.chatId !== state.userId) continue;
    const createdAt = timestamp(candidate.createdAt) ? candidate.createdAt : 0;
    const expiresAt = timestamp(candidate.expiresAt) ? candidate.expiresAt : null;
    if (candidate.id.startsWith('reminder_') && (reminders.enabled !== true || expiresAt === null)) {
      due.push(createdAt); // Clean up a disabled/legacy reminder even if an old lease is still present.
      continue;
    }
    const availableAt = Math.max(createdAt, timestamp(candidate.retryAt) ? candidate.retryAt : 0,
      timestamp(candidate.leaseUntil) ? candidate.leaseUntil : 0);
    due.push(expiresAt === null ? availableAt : Math.min(availableAt, expiresAt));
  }
  const reminder = nextReminderAt(reminders, now);
  if (reminder !== null) due.push(reminder);
  return due.length ? Math.min(...due) : null;
}
