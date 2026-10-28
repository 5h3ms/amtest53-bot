import { describe, expect, it } from 'vitest';
import { aggregateUsage, ANALYTICS_MAX_BYTES, ANALYTICS_QUESTION_LIMIT, recordUsage, renderStats, type AnalyticsQuestion,
  type AnalyticsUser, type UsageAnalytics, type UsageEvent } from '../src/analytics.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86_400_000;
const question: AnalyticsQuestion = { id: 'q001', version: 'v1', prompt: 'Какой орган?', options: ['Парламент', 'Правительство', 'Суд', 'Президент'], correctIndex: 0 };
const answer = (selected = 0, hinted = false, q = question): UsageEvent => ({ kind: 'answer', selected, hinted, correct: selected === q.correctIndex, question: q });
const user = (analytics?: UsageAnalytics, updatedAt = NOW, userId = 1): AnalyticsUser => ({ userId, updatedAt, analytics });

describe('bounded usage history', () => {
  it('starts lazily without fabricating earlier history and does not mutate the previous state', () => {
    const initial = recordUsage(undefined, { kind: 'active' }, NOW);
    const before = structuredClone(initial);
    const next = recordUsage(initial, answer(), NOW);
    expect(initial).toEqual(before);
    expect(initial.days['2026-10-28']?.answers).toBe(0);
    expect(next.days['2026-10-28']).toMatchObject({ active: 1, answers: 1, correctUnhinted: 1 });
    expect(next.startedAt).toBe(NOW);
    expect(next.firstActiveAt).toBe(NOW);
  });

  it('counts selected answer text across shuffled positions, and separates content versions', () => {
    let history = recordUsage(undefined, answer(1), NOW);
    const shuffled = { ...question, options: ['Суд', 'Президент', 'Парламент', 'Правительство'], correctIndex: 2 };
    history = recordUsage(history, answer(3, false, shuffled), NOW + 1);
    history = recordUsage(history, answer(2, true, shuffled), NOW + 2);
    history = recordUsage(history, answer(0, false, { ...question, version: 'v2' }), NOW + 3);
    const entries = Object.values(history.questions);
    expect(entries).toHaveLength(2);
    const first = entries.find(q => q.version === 'v1')!;
    expect(first).toMatchObject({ answers: 3, correct: 1, correctUnhinted: 0, hintedAnswers: 1 });
    expect(Object.values(first.options).find(option => option.text === 'Правительство')).toMatchObject({ count: 2, correct: false });
    expect(Object.values(first.options).find(option => option.text === 'Парламент')).toMatchObject({ count: 1, correct: true });
  });

  it('retains exactly 90 UTC date buckets and filters stale untouched users at read time', () => {
    let history: UsageAnalytics | undefined;
    for (let daysAgo = 100; daysAgo >= 0; daysAgo--) history = recordUsage(history, { kind: 'active' }, NOW - daysAgo * DAY);
    expect(Object.keys(history!.days)).toHaveLength(90);
    expect(Object.keys(history!.days).sort()[0]).toBe(new Date(NOW - 89 * DAY).toISOString().slice(0, 10));
    const stale = recordUsage(undefined, { kind: 'start' }, NOW - 91 * DAY);
    const result = aggregateUsage([user(history), user(stale, NOW - 91 * DAY, 2)], NOW);
    expect(result.totals.starts).toBe(0);
    expect(result.dailyActive).toHaveLength(90);
    expect(result.dailyActive.at(-1)).toEqual({ date: '2026-10-28', users: 1 });
  });

  it('records session, hint and exam totals without equating opened hints with hinted answers', () => {
    let history: UsageAnalytics | undefined;
    for (const event of [{ kind: 'active' }, { kind: 'start' }, { kind: 'hint' }, { kind: 'hint' }, answer(0, true), answer(1),
      { kind: 'complete' }, { kind: 'exam', score: 20, total: 33, passed: true }] as UsageEvent[]) history = recordUsage(history, event, NOW);
    expect(aggregateUsage([user(history)], NOW).totals).toMatchObject({ active: 1, starts: 1, completed: 1, hints: 2,
      answers: 2, hintedAnswers: 1, correctUnhinted: 0, exams: 1, passedExams: 1, examScore: 20, examTotal: 33 });
  });

  it('does not count an automatic timeout as active usage or a returning user', () => {
    let history = recordUsage(undefined, { kind: 'active' }, NOW - 10 * DAY);
    history = recordUsage(history, { kind: 'exam', score: 1, total: 33, passed: false }, NOW - 9 * DAY);
    history = recordUsage(history, { kind: 'complete' }, NOW - 9 * DAY);
    const summary = aggregateUsage([user(history, NOW - 10 * DAY)], NOW);
    expect(summary.dailyActive).toHaveLength(1);
    expect(summary.return7d).toEqual({ eligible: 1, returned: 0 });
    expect(summary.totals.exams).toBe(1);
    const schedulerOnly = recordUsage(undefined, { kind: 'exam', score: 0, total: 33, passed: false }, NOW - 10 * DAY);
    expect(schedulerOnly.firstActiveAt).toBeUndefined();
    expect(aggregateUsage([user(schedulerOnly, NOW - 11 * DAY)], NOW).return7d.eligible).toBe(0);
  });

  it('measures returns only after seven complete UTC dates, including day 6 but excluding day 7', () => {
    const start = Date.parse('2026-10-01T23:59:00Z');
    const initial = recordUsage(undefined, { kind: 'active' }, start);
    const day6 = recordUsage(initial, { kind: 'active' }, Date.parse('2026-10-07T12:00:00Z'));
    const day7 = recordUsage(initial, { kind: 'active' }, Date.parse('2026-10-08T12:00:00Z'));
    expect(aggregateUsage([user(day6)], Date.parse('2026-10-07T23:59:00Z')).return7d.eligible).toBe(0);
    const mature = aggregateUsage([user(day6), user(day7, NOW, 2)], Date.parse('2026-10-09T00:00:00Z'));
    expect(mature.return7d).toEqual({ eligible: 2, returned: 1 });
  });

  it('counts registered legacy users and activity without inventing their learning totals', () => {
    const summary = aggregateUsage([user(undefined), user(undefined, NOW - 2 * DAY, 2), user(undefined, NOW - 8 * DAY, 3),
      user(undefined, NOW - 31 * DAY, 4), user(undefined, NOW + DAY, 5)], NOW);
    expect(summary).toMatchObject({ users: 5, observedUsers: 0, active24h: 1, active7d: 2, active30d: 3,
      learners7d: 0, historyStartedAt: null });
    expect(summary.totals.answers).toBe(0);
  });

  it('bounds question count and stored bytes while retaining newest observations', () => {
    let history: UsageAnalytics | undefined;
    for (let index = 0; index < ANALYTICS_QUESTION_LIMIT + 5; index++) {
      history = recordUsage(history, answer(0, false, { ...question, id: `q${index}` }), NOW + index);
    }
    expect(Object.values(history!.questions)).toHaveLength(ANALYTICS_QUESTION_LIMIT);
    expect(Object.values(history!.questions).some(q => q.id === `q${ANALYTICS_QUESTION_LIMIT + 4}`)).toBe(true);
    const large = structuredClone(history!);
    for (const entry of Object.values(large.questions)) {
      entry.options = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), { text: 'ա'.repeat(100), count: 1, correct: false }]));
    }
    const compact = recordUsage(large, { kind: 'active' }, NOW + 1000);
    expect(Buffer.byteLength(JSON.stringify(compact), 'utf8')).toBeLessThanOrEqual(ANALYTICS_MAX_BYTES);
    expect(Object.keys(large.questions)).toHaveLength(ANALYTICS_QUESTION_LIMIT);
  });

  it('combines question counts across users without mutating user history and renders denominators', () => {
    let first = recordUsage(undefined, answer(1), NOW);
    first = recordUsage(first, answer(1), NOW + 1);
    const second = recordUsage(undefined, answer(0), NOW);
    const before = structuredClone(first);
    const result = aggregateUsage([user(first), user(second, NOW, 2)], NOW + 2);
    expect(first).toEqual(before);
    expect(result.questions[0]).toMatchObject({ answers: 3, correct: 1 });
    const text = renderStats(result);
    expect(text).toContain('67% (2/3)');
    expect(text).toContain('Правительство');
    expect(text).toContain('2/3');
    expect(text).toContain('90 календарных дней');
    expect(text.length).toBeLessThan(4096);
  });

  it('rejects impossible exam scores and invalid option selections without touching the old state', () => {
    const previous = recordUsage(undefined, { kind: 'active' }, NOW), before = structuredClone(previous);
    expect(() => recordUsage(previous, { kind: 'exam', score: 34, total: 33, passed: true }, NOW)).toThrow(/Invalid/);
    expect(() => recordUsage(previous, answer(4), NOW)).toThrow(/Invalid/);
    expect(previous).toEqual(before);
  });
});
