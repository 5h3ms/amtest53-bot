import { createHash } from 'node:crypto';

export const FEEDBACK_LIMIT = 20;
export const FEEDBACK_TTL_MS = 30 * 60_000;
export const FEEDBACK_CATEGORY_LABELS = {
  translation: 'Ошибка перевода', ambiguous: 'Неоднозначный вопрос', answer: 'Неверный ответ', other: 'Другая проблема',
} as const;
export type FeedbackCategory = keyof typeof FEEDBACK_CATEGORY_LABELS;
export interface FeedbackTarget { kind: 'word' | 'question'; id: string; contentVersion: string; prompt: string; options?: string[] }
export interface FeedbackReport { id: string; at: number; target: FeedbackTarget; category: FeedbackCategory; description: string }
export interface FeedbackState {
  reports: FeedbackReport[];
  pending?: { token: string; target: FeedbackTarget; category?: FeedbackCategory; startedAt: number; expiresAt: number };
}
export interface FeedbackUser { userId: number; feedback?: FeedbackState }
export interface OwnedFeedbackReport { userId: number; report: FeedbackReport }

function clean(text: string): string { return text.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(); }
function current(previous: FeedbackState | undefined): FeedbackState {
  return previous && Array.isArray(previous.reports) ? structuredClone(previous) : { reports: [] };
}
export function snapshotFeedbackTarget(target: FeedbackTarget): FeedbackTarget {
  if (!['word', 'question'].includes(target.kind) || !/^[a-z][a-z0-9_-]{1,39}$/.test(target.id) || !target.contentVersion.trim() || !target.prompt.trim()) {
    throw new Error('Invalid feedback target');
  }
  return { kind: target.kind, id: target.id, contentVersion: clean(target.contentVersion).slice(0, 100), prompt: clean(target.prompt).slice(0, 350),
    ...(target.options ? { options: target.options.slice(0, 4).map(option => clean(option).slice(0, 150)) } : {}) };
}
export function beginFeedback(previous: FeedbackState | undefined, target: FeedbackTarget, now: number, eventId = ''): FeedbackState {
  const state = current(previous);
  const snapshot = snapshotFeedbackTarget(target);
  const token = createHash('sha256').update(JSON.stringify([snapshot, now, eventId])).digest('hex').slice(0, 12);
  state.pending = { token, target: snapshot, startedAt: now, expiresAt: now + FEEDBACK_TTL_MS };
  return state;
}
export function pendingFeedback(previous: FeedbackState | undefined, now: number): FeedbackState['pending'] {
  return previous?.pending && previous.pending.expiresAt > now ? structuredClone(previous.pending) : undefined;
}
export function chooseFeedbackCategory(previous: FeedbackState | undefined, category: string, now: number, token?: string): FeedbackState {
  const pending = pendingFeedback(previous, now);
  if (!pending || (token !== undefined && token !== pending.token) || !Object.hasOwn(FEEDBACK_CATEGORY_LABELS, category)) throw new Error('Feedback expired or invalid category');
  return { ...current(previous), pending: { ...pending, category: category as FeedbackCategory } };
}
export function cancelFeedback(previous: FeedbackState | undefined, token?: string): FeedbackState {
  if (token !== undefined && token !== previous?.pending?.token) throw new Error('Feedback token mismatch');
  const state = current(previous); delete state.pending; return state;
}
export function submitFeedback(previous: FeedbackState | undefined, description: string | undefined, now: number, eventId: string, token?: string): { state: FeedbackState; report: FeedbackReport } {
  const pending = pendingFeedback(previous, now);
  if (!pending?.category || (token !== undefined && token !== pending.token)) throw new Error('Choose a feedback category first');
  const text = clean(description ?? '');
  if (text.startsWith('/') || text.length > 1000 || !eventId) throw new Error('Invalid feedback description');
  const id = createHash('sha256').update(JSON.stringify([eventId, pending.target, pending.category])).digest('hex').slice(0, 20);
  const state = current(previous);
  const report = state.reports.find(item => item.id === id) ?? { id, at: now, target: pending.target, category: pending.category, description: text };
  state.reports = [...state.reports.filter(item => item.id !== id), report].slice(-FEEDBACK_LIMIT);
  delete state.pending;
  return { state, report };
}
export function collectReports(users: readonly FeedbackUser[]): OwnedFeedbackReport[] {
  return users.flatMap(user => (user.feedback?.reports ?? []).map(report => ({ userId: user.userId, report: structuredClone(report) })))
    .sort((a, b) => b.report.at - a.report.at || a.report.id.localeCompare(b.report.id));
}
export function renderReportPage(reports: readonly OwnedFeedbackReport[], requestedPage = 0): { text: string; page: number; pages: number } {
  if (!reports.length) return { text: 'Сообщений об ошибках пока нет.', page: 0, pages: 0 };
  const page = Number.isSafeInteger(requestedPage) ? Math.max(0, Math.min(requestedPage, reports.length - 1)) : 0;
  const { userId, report } = reports[page]!;
  const target = report.target;
  const lines = [`Сообщение об ошибке ${page + 1}/${reports.length}`, `Дата: ${new Date(report.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Пользователь: ${userId}`, `Тип: ${FEEDBACK_CATEGORY_LABELS[report.category]}`, `Задание: ${target.id} (${target.kind === 'word' ? 'слово' : 'вопрос'})`,
    `Версия: ${target.contentVersion}`, '', target.prompt];
  if (target.options?.length) lines.push(...target.options.map((option, index) => `${index + 1}. ${option}`));
  lines.push('', report.description || 'Описание не добавлено.', '', `Хранятся последние ${FEEDBACK_LIMIT} сообщений каждого пользователя.`);
  return { text: lines.join('\n'), page, pages: reports.length };
}
