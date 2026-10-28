import { describe, expect, it } from 'vitest';
import type { Question } from '../src/course.js';
import { isQuestionMastered, selectPracticeQuestions, topicProgress, updateQuestionProgress, type QuestionProgressMap } from '../src/question-review.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-28T12:00:00Z');
const question = (id: string, topic = 'Основы'): Question => ({ id, topic, promptHy: 'Հարց', promptRu: 'Вопрос',
  options: [{ hy: 'Ա', ru: 'А' }, { hy: 'Բ', ru: 'Б' }, { hy: 'Գ', ru: 'В' }, { hy: 'Դ', ru: 'Г' }],
  correctIndex: 0, explanationRu: 'Объяснение', vocabularyIds: [],
  source: { url: 'https://arlis.am/hy/acts/143723/latest', article: '1', checkedOn: '2026-10-28' } });
const bank = (size: number) => Array.from({ length: size }, (_, index) => question(`q${String(index + 1).padStart(3, '0')}`));
const correct = (map: QuestionProgressMap, id: string, now: number) => updateQuestionProgress(map, id, { correct: true, hinted: false, now });

describe('spaced question progress', () => {
  it('starts with a one-day interval and does not mutate the supplied progress', () => {
    const original: QuestionProgressMap = {};
    const next = correct(original, 'q001', NOW);
    expect(original).toEqual({});
    expect(next.q001).toEqual({ seen: 1, mistakes: 0, level: 1, dueAt: NOW + DAY, successfulDays: 1,
      lastAnsweredAt: NOW, lastSuccessfulDay: '2026-10-28' });
    expect(isQuestionMastered(next.q001)).toBe(false);
  });

  it('uses 1/3/7/14/30-day intervals and credits mastery only after three due successes', () => {
    let map: QuestionProgressMap = {};
    let now = NOW;
    for (const [index, interval] of [1, 3, 7, 14, 30, 30].entries()) {
      map = correct(map, 'q001', now);
      expect(map.q001!.dueAt).toBe(now + interval * DAY);
      expect(map.q001!.level).toBe(Math.min(index + 1, 5));
      expect(map.q001!.successfulDays).toBe(Math.min(index + 1, 5));
      expect(isQuestionMastered(map.q001)).toBe(index >= 2);
      now = map.q001!.dueAt;
    }
  });

  it('counts early answers without advancing the due date, level, or successful days', () => {
    let map = correct({}, 'q001', NOW);
    map = correct(map, 'q001', NOW + DAY);
    const before = structuredClone(map);
    const early = correct(map, 'q001', NOW + 2 * DAY);
    expect(map).toEqual(before);
    expect(early.q001).toMatchObject({ seen: 3, level: 2, successfulDays: 2, dueAt: NOW + 4 * DAY,
      lastSuccessfulDay: '2026-10-29', lastAnsweredAt: NOW + 2 * DAY });
    expect(isQuestionMastered(early.q001)).toBe(false);
  });

  it.each([{ correct: false, hinted: false, mistakes: 1 }, { correct: true, hinted: true, mistakes: 0 },
    { correct: false, hinted: true, mistakes: 1 }])('resets the success series for a wrong or hinted answer: %j', answer => {
    let map = correct({}, 'q001', NOW);
    map = correct(map, 'q001', NOW + DAY);
    map = correct(map, 'q001', NOW + 4 * DAY);
    expect(isQuestionMastered(map.q001)).toBe(true);
    const next = updateQuestionProgress(map, 'q001', { ...answer, now: NOW + 5 * DAY });
    expect(next.q001).toMatchObject({ level: 0, successfulDays: 0, seen: 4, mistakes: answer.mistakes,
      dueAt: NOW + 5 * DAY + 600_000 });
    expect(isQuestionMastered(next.q001)).toBe(false);
  });

  it('does not award two successful days after a same-day error and retry', () => {
    let map = correct({}, 'q001', NOW);
    map = updateQuestionProgress(map, 'q001', { correct: false, hinted: false, now: NOW + 60_000 });
    map = correct(map, 'q001', NOW + 660_000);
    expect(map.q001).toMatchObject({ level: 0, successfulDays: 0, mistakes: 1, seen: 3,
      lastSuccessfulDay: '2026-10-28', dueAt: Date.parse('2026-10-29T00:00:00Z') });
    map = correct(map, 'q001', Date.parse('2026-10-29T00:00:00Z'));
    expect(map.q001).toMatchObject({ level: 1, successfulDays: 1, lastSuccessfulDay: '2026-10-29' });
  });

  it('does not confuse crossing UTC midnight with a completed one-day interval', () => {
    const late = Date.parse('2026-10-28T23:59:00Z');
    const map = correct(correct({}, 'q001', late), 'q001', late + 120_000);
    expect(map.q001).toMatchObject({ level: 1, successfulDays: 1, dueAt: late + DAY, lastSuccessfulDay: '2026-10-28' });
  });

  it('keeps other question records and rejects invalid IDs or time', () => {
    const map = correct({}, 'q002', NOW);
    const next = correct(map, 'q001', NOW);
    expect(next.q002).toEqual(map.q002);
    expect(() => correct(map, '__proto__', NOW)).toThrow(/ID/);
    expect(() => correct(map, 'q001', Number.NaN)).toThrow(/time/);
  });
});

describe('practice queue and topic coverage', () => {
  it('prioritizes the oldest due questions and makes room for new material', () => {
    const questions = bank(20);
    let map: QuestionProgressMap = {};
    for (let index = 0; index < 12; index++) map = correct(map, questions[index]!.id, NOW - 2 * DAY + index * 1000);
    const original = structuredClone(map);
    const selected = selectPracticeQuestions(questions, map, {}, { seed: 'queue', now: NOW, limit: 10 });
    expect(selected.slice(0, 7).map(q => q.id)).toEqual(questions.slice(0, 7).map(q => q.id));
    expect(selected.slice(7).every(q => !map[q.id])).toBe(true);
    expect(selected).toHaveLength(10);
    expect(map).toEqual(original);
  });

  it('moves answered due questions out of the way, allowing all old errors to be reviewed', () => {
    const questions = bank(20);
    let map: QuestionProgressMap = {};
    for (const q of questions) map = correct(map, q.id, NOW - 2 * DAY);
    const first = selectPracticeQuestions(questions, map, {}, { seed: 'same', now: NOW, limit: 10, dueOnly: true });
    for (const q of first) map = updateQuestionProgress(map, q.id, { correct: false, hinted: false, now: NOW });
    const second = selectPracticeQuestions(questions, map, {}, { seed: 'same', now: NOW, limit: 10, dueOnly: true });
    expect(new Set([...first, ...second].map(q => q.id)).size).toBe(20);
  });

  it('uses legacy mistakes to order unmeasured questions without inventing progress', () => {
    const questions = bank(12), progress = {};
    const selected = selectPracticeQuestions(questions, progress, { q011: 4, q012: 2 }, { seed: 'legacy', now: NOW, limit: 3 });
    expect(selected.slice(0, 2).map(q => q.id)).toEqual(['q011', 'q012']);
    expect(progress).toEqual({});
  });

  it('is deterministic for a seed, varies new material across seeds, and never repeats a question', () => {
    const questions = bank(30);
    const select = (seed: string) => selectPracticeQuestions([...questions, questions[0]!], {}, {}, { seed, now: NOW, limit: 10 }).map(q => q.id);
    expect(select('first')).toEqual(select('first'));
    expect(select('first')).not.toEqual(select('second'));
    expect(new Set(select('first')).size).toBe(10);
    expect(questions.map(q => q.id)).toEqual(bank(30).map(q => q.id));
  });

  it('never includes new or early questions in due-only mode, even with allowEarly enabled', () => {
    const questions = bank(3);
    const progress = correct(correct({}, 'q001', NOW - 2 * DAY), 'q002', NOW);
    expect(selectPracticeQuestions(questions, progress, {}, { seed: 'x', now: NOW, dueOnly: true, allowEarly: true }).map(q => q.id)).toEqual(['q001']);
  });

  it('treats a zero-attempt record as new rather than placing it in two queues', () => {
    const questions = bank(2), progress = correct({}, 'q001', NOW - 2 * DAY);
    progress.q001!.seen = 0;
    const selected = selectPracticeQuestions(questions, progress, {}, { seed: 'x', now: NOW });
    expect(selected).toHaveLength(2);
    expect(new Set(selected.map(q => q.id)).size).toBe(2);
    expect(selectPracticeQuestions(questions, progress, {}, { seed: 'x', now: NOW, dueOnly: true })).toEqual([]);
  });

  it('allows explicit extra practice only when requested and uses the nearest due date first', () => {
    const questions = bank(3);
    let progress = correct(correct({}, 'q001', NOW), 'q002', NOW + 1000);
    progress = correct(progress, 'q003', NOW + 2000);
    expect(selectPracticeQuestions(questions, progress, {}, { seed: 'x', now: NOW })).toEqual([]);
    expect(selectPracticeQuestions(questions, progress, {}, { seed: 'x', now: NOW, allowEarly: true, limit: 2 }).map(q => q.id)).toEqual(['q001', 'q002']);
  });

  it('fills spare new-material quota with due questions and observes limits', () => {
    const questions = bank(11);
    let progress: QuestionProgressMap = {};
    for (const q of questions.slice(0, 10)) progress = correct(progress, q.id, NOW - 2 * DAY);
    const selected = selectPracticeQuestions(questions, progress, {}, { seed: 'x', now: NOW, limit: 10 });
    expect(selected).toHaveLength(10);
    expect(selected.at(-1)?.id).toBe('q011');
    expect(selected.slice(0, 9).every(q => progress[q.id])).toBe(true);
    expect(selectPracticeQuestions(questions, {}, {}, { seed: 'x', now: NOW, limit: 0 })).toEqual([]);
    for (const limit of [-1, 1.5, 101]) expect(() => selectPracticeQuestions(questions, {}, {}, { seed: 'x', now: NOW, limit })).toThrow(/limit/);
  });

  it('reports measured mastery, seen coverage and due count by current topic only', () => {
    const questions = [question('q001', 'Права'), question('q002', 'Права'), question('q003', 'Органы')];
    let progress = correct({}, 'q001', NOW - 10 * DAY);
    progress = correct(progress, 'q001', NOW - 9 * DAY);
    progress = correct(progress, 'q001', NOW - 6 * DAY);
    progress = updateQuestionProgress(progress, 'q003', { correct: false, hinted: false, now: NOW - DAY });
    progress = correct(progress, 'q999', NOW);
    expect(topicProgress({ questions }, progress, NOW)).toEqual([
      { topic: 'Права', total: 2, seen: 1, mastered: 1, due: 0 },
      { topic: 'Органы', total: 1, seen: 1, mastered: 0, due: 1 },
    ]);
  });
});
