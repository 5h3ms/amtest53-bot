import { createHash } from 'node:crypto';
import type { Course, Question } from './course.js';

const DAY = 86_400_000;
const RETRY_DELAY = 10 * 60_000;
const INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;

export interface QuestionProgress {
  seen: number;
  mistakes: number;
  level: number;
  dueAt: number;
  successfulDays: number;
  lastAnsweredAt: number;
  /** UTC date of the last success credited towards an interval, not early practice. */
  lastSuccessfulDay: string | null;
}
export type QuestionProgressMap = Record<string, QuestionProgress>;
export interface TopicProgress {
  topic: string;
  total: number;
  seen: number;
  mastered: number;
  due: number;
}

function assertTime(now: number): void {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid review time');
}
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** A single successful attempt is not mastery; successes must be spaced across days. */
export function isQuestionMastered(progress: QuestionProgress | undefined): boolean {
  return Boolean(progress && progress.level >= 3 && progress.successfulDays >= 3);
}

/** Returns a new map. Caller deduplicates Telegram events before recording answers. */
export function updateQuestionProgress(
  progress: QuestionProgressMap,
  questionId: string,
  answer: { correct: boolean; hinted: boolean; now: number },
): QuestionProgressMap {
  const { correct, hinted, now } = answer;
  assertTime(now);
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(questionId)) throw new Error('Invalid question ID');
  const previous = progress[questionId];
  const next: QuestionProgress = previous ? { ...previous } : {
    seen: 0, mistakes: 0, level: 0, dueAt: now, successfulDays: 0,
    lastAnsweredAt: now, lastSuccessfulDay: null,
  };
  next.seen++;
  next.lastAnsweredAt = now;
  if (!correct || hinted) {
    next.level = 0;
    next.successfulDays = 0;
    next.dueAt = now + RETRY_DELAY;
    if (!correct) next.mistakes++;
  } else if (next.dueAt <= now) {
    if (next.lastSuccessfulDay !== dayOf(now)) {
      next.dueAt = now + INTERVAL_DAYS[Math.min(next.level, INTERVAL_DAYS.length - 1)]! * DAY;
      next.level = Math.min(next.level + 1, INTERVAL_DAYS.length);
      next.successfulDays = Math.min(next.successfulDays + 1, INTERVAL_DAYS.length);
      next.lastSuccessfulDay = dayOf(now);
    } else {
      // After a same-day lapse and retry, wait until tomorrow without claiming
      // a second day of successful recall or leaving the item immediately due.
      next.dueAt = (Math.floor(now / DAY) + 1) * DAY;
    }
  }
  return { ...progress, [questionId]: next };
}

export interface PracticeSelectionOptions {
  seed: string;
  now: number;
  limit?: number;
  dueOnly?: boolean;
  /** Only explicit extra practice should include material before its due date. */
  allowEarly?: boolean;
}

/** Due items precede new ones. New material gets room even with a long review queue. */
export function selectPracticeQuestions(
  questions: readonly Question[],
  progress: QuestionProgressMap,
  legacyMistakes: Readonly<Record<string, number>>,
  options: PracticeSelectionOptions,
): Question[] {
  const { seed, now, dueOnly = false, allowEarly = false, limit = 10 } = options;
  assertTime(now);
  if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw new Error('Invalid practice limit');
  if (!limit) return [];
  const unique = [...new Map(questions.map(question => [question.id, question])).values()];
  const ranks = new Map(unique.map(question => [question.id, createHash('sha256').update(`${seed}:${question.id}`).digest('hex')]));
  const randomOrder = (a: Question, b: Question) => ranks.get(a.id)!.localeCompare(ranks.get(b.id)!);
  const due = unique.filter(question => progress[question.id] && progress[question.id]!.seen > 0 && progress[question.id]!.dueAt <= now)
    .sort((a, b) => progress[a.id]!.dueAt - progress[b.id]!.dueAt || randomOrder(a, b));
  if (dueOnly) return due.slice(0, limit);
  const unseen = unique.filter(question => !progress[question.id] || progress[question.id]!.seen === 0)
    .sort((a, b) => Math.max(0, legacyMistakes[b.id] ?? 0) - Math.max(0, legacyMistakes[a.id] ?? 0) || randomOrder(a, b));
  const dueBudget = unseen.length ? Math.ceil(limit * 0.7) : limit;
  const chosenDue = due.slice(0, dueBudget);
  const chosenNew = unseen.slice(0, limit - chosenDue.length);
  // If fewer new questions exist than the reserved space, use the remaining due queue.
  const remaining = limit - chosenDue.length - chosenNew.length;
  chosenDue.push(...due.slice(chosenDue.length, chosenDue.length + remaining));
  const selected = [...chosenDue, ...chosenNew];
  if (allowEarly && selected.length < limit) {
    const selectedIds = new Set(selected.map(question => question.id));
    const early = unique.filter(question => !selectedIds.has(question.id) && progress[question.id] && progress[question.id]!.seen > 0 && progress[question.id]!.dueAt > now)
      .sort((a, b) => progress[a.id]!.dueAt - progress[b.id]!.dueAt || randomOrder(a, b));
    selected.push(...early.slice(0, limit - selected.length));
  }
  return selected;
}

/** Counts only questions in the current course; historical/deleted IDs do not inflate coverage. */
export function topicProgress(course: Pick<Course, 'questions'>, progress: QuestionProgressMap, now: number): TopicProgress[] {
  assertTime(now);
  const topics = new Map<string, TopicProgress>();
  const visited = new Set<string>();
  for (const question of course.questions) {
    if (visited.has(question.id)) continue;
    visited.add(question.id);
    const summary = topics.get(question.topic) ?? { topic: question.topic, total: 0, seen: 0, mastered: 0, due: 0 };
    const item = progress[question.id];
    summary.total++;
    if (item?.seen) summary.seen++;
    if (isQuestionMastered(item)) summary.mastered++;
    if (item && item.seen > 0 && item.dueAt <= now) summary.due++;
    topics.set(question.topic, summary);
  }
  return [...topics.values()];
}
