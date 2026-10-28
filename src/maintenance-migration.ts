import { FieldPath, type Firestore, type Query } from 'firebase-admin/firestore';
import { deriveMaintenanceIndex, isMaintenanceUser, MAINTENANCE_INDEX_VERSION } from './maintenance-index.js';
import { FirestoreStateStore } from './storage.js';

export const MAINTENANCE_READY_KEY = 'meta_maintenance_index_v1';
const PAGE_SIZE = 100;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validTimestamp = (value: unknown): value is number => typeof value === 'number' &&
  Number.isFinite(value) && Number.isFinite(new Date(value).getTime());

export interface MaintenanceMigrationSummary {
  apply: boolean;
  scanned: number;
  updated: number;
  unchanged: number;
  invalid: number;
  missing: number;
  verified: number;
  verificationInvalid: number;
  verificationMissing: number;
  readyPublished: boolean;
}

/** Validate legacy records without normalizing or reserializing their saved learning state. */
function userState(data: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(data) || data.key !== key || data.version !== 1 || typeof data.stateJson !== 'string' ||
    Buffer.byteLength(data.stateJson, 'utf8') > 900 * 1024) return null;
  let state: unknown;
  try { state = JSON.parse(data.stateJson); } catch { return null; }
  if (!isMaintenanceUser(state, key) || !Array.isArray(state.processedEvents) ||
    !Array.isArray(state.exams) || !Array.isArray(state.completedLessons) ||
    !isRecord(state.cards) || !isRecord(state.questionMistakes)) return null;
  const reminders = state.reminders as Record<string, unknown>;
  if (typeof reminders.enabled !== 'boolean' || typeof reminders.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(reminders.time) || typeof reminders.timeZone !== 'string') return null;
  if (reminders.enabled) {
    try { new Intl.DateTimeFormat('en', { timeZone: reminders.timeZone }).format(); } catch { return null; }
  }
  const session = state.session;
  if (session !== null && (!isRecord(session) || typeof session.id !== 'string' ||
    !['lesson', 'practice', 'exam', 'review'].includes(session.kind as string) ||
    !Array.isArray(session.steps) || !Array.isArray(session.answers) ||
    session.answers.some(answer => !isRecord(answer) || typeof answer.correct !== 'boolean') ||
    (session.endedAt !== null && !validTimestamp(session.endedAt)) ||
    (session.deadlineAt !== null && !validTimestamp(session.deadlineAt)) ||
    (session.kind === 'exam' && session.endedAt === null && !validTimestamp(session.deadlineAt)))) return null;
  for (const item of state.outbox as unknown[]) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.userId !== state.userId ||
      item.chatId !== state.userId || !isRecord(item.view) || typeof item.view.text !== 'string' ||
      !validTimestamp(item.createdAt) || !validTimestamp(item.leaseUntil) ||
      (item.expiresAt !== undefined && item.expiresAt !== null && !validTimestamp(item.expiresAt)) ||
      (item.retryAt !== undefined && !validTimestamp(item.retryAt))) return null;
  }
  return state;
}

/**
 * Run only after all application writers derive metadata atomically with user state.
 * A concurrent application update is re-read inside each transaction and never overwritten.
 */
export async function backfillMaintenanceIndex(
  db: Firestore, options: { apply: boolean; now?: number },
): Promise<MaintenanceMigrationSummary> {
  const now = options.now ?? Date.now();
  if (typeof options.apply !== 'boolean' || !validTimestamp(now)) throw new Error('Invalid migration options');
  const summary: MaintenanceMigrationSummary = { apply: options.apply, scanned: 0, updated: 0,
    unchanged: 0, invalid: 0, missing: 0, verified: 0, verificationInvalid: 0,
    verificationMissing: 0, readyPublished: false };
  const store = new FirestoreStateStore(db);
  // A partial or failed rerun must never leave the ready flag enabled.
  if (options.apply) await store.update(MAINTENANCE_READY_KEY, () => ({
    state: { ready: false, version: MAINTENANCE_INDEX_VERSION, startedAt: now }, result: undefined,
  }));
  const collection = db.collection('botState');
  const users = () => collection.where(FieldPath.documentId(), '>=', 'u_')
    .where(FieldPath.documentId(), '<=', 'u_\uf8ff').orderBy(FieldPath.documentId());
  let after: string | undefined;
  do {
    const query: Query = after === undefined ? users() : users().startAfter(after);
    const page = await query.limit(PAGE_SIZE).get();
    for (const listed of page.docs) {
      summary.scanned++;
      const outcome = await db.runTransaction(async transaction => {
        const latest = await transaction.get(listed.ref);
        if (!latest.exists) return 'missing' as const;
        const data = latest.data(), state = userState(data, latest.id);
        if (!state) return 'invalid' as const;
        const nextMaintenanceAt = deriveMaintenanceIndex(state, latest.id, now);
        if (data?.maintenanceIndexVersion === MAINTENANCE_INDEX_VERSION && data.nextMaintenanceAt === nextMaintenanceAt) {
          return 'unchanged' as const;
        }
        if (options.apply) transaction.update(latest.ref, {
          maintenanceIndexVersion: MAINTENANCE_INDEX_VERSION, nextMaintenanceAt,
        });
        return 'updated' as const;
      });
      summary[outcome]++;
    }
    if (page.docs.length < PAGE_SIZE) break;
    after = page.docs.at(-1)!.id;
  } while (true);
  if (!options.apply) return summary;

  // Verify the current collection, including records created while the first pass ran.
  after = undefined;
  do {
    const query: Query = after === undefined ? users() : users().startAfter(after);
    const page = await query.limit(PAGE_SIZE).get();
    for (const document of page.docs) {
      summary.verified++;
      const data = document.data(), state = userState(data, document.id);
      if (!state) { summary.verificationInvalid++; continue; }
      const next = data.nextMaintenanceAt;
      if (data.maintenanceIndexVersion !== MAINTENANCE_INDEX_VERSION ||
        (next !== null && !validTimestamp(next)) ||
        // The exact timestamp can legitimately change while live requests are handled.
        (next === null) !== (deriveMaintenanceIndex(state, document.id, now) === null)) summary.verificationMissing++;
    }
    if (page.docs.length < PAGE_SIZE) break;
    after = page.docs.at(-1)!.id;
  } while (true);
  if (summary.invalid || summary.missing || summary.verificationInvalid || summary.verificationMissing) return summary;

  // Exercise the same indexed query as production before enabling it.
  await store.listDuePage(now, { limit: 1 });
  const completedAt = options.now ?? Date.now();
  await store.update(MAINTENANCE_READY_KEY, () => ({
    state: { ready: true, version: MAINTENANCE_INDEX_VERSION, completedAt,
      scanned: summary.scanned, updated: summary.updated, unchanged: summary.unchanged, verified: summary.verified },
    result: undefined,
  }));
  summary.readyPublished = true;
  return summary;
}
