import { describe, expect, it } from 'vitest';
import { beginFeedback, cancelFeedback, chooseFeedbackCategory, collectReports, FEEDBACK_LIMIT, FEEDBACK_TTL_MS,
  pendingFeedback, renderReportPage, snapshotFeedbackTarget, submitFeedback, type FeedbackState, type FeedbackTarget } from '../src/feedback.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const target: FeedbackTarget = { kind: 'question', id: 'q001', contentVersion: 'v4', prompt: 'Ո՞վ։', options: ['Ա', 'Բ', 'Գ', 'Դ'] };
function ready(previous?: FeedbackState, now = NOW, eventId = 'open') {
  const started = beginFeedback(previous, target, now, eventId);
  return chooseFeedbackCategory(started, 'ambiguous', now, started.pending!.token);
}

describe('explicit task feedback', () => {
  it('keeps a bounded snapshot independent of future content changes, without an answer key', () => {
    const original = structuredClone(target);
    const state = beginFeedback(undefined, original, NOW, 'first');
    original.prompt = 'changed'; original.options![0] = 'changed';
    expect(state.pending?.target).toEqual(target);
    expect(Object.keys(state.pending!.target)).not.toContain('correctIndex');
    const large = snapshotFeedbackTarget({ ...target, prompt: 'ա'.repeat(1000), options: Array.from({ length: 7 }, () => 'բ'.repeat(300)) });
    expect(large.prompt).toHaveLength(350);
    expect(large.options).toHaveLength(4);
    expect(large.options![0]).toHaveLength(150);
  });

  it('gives new wizards distinct tokens even at the same timestamp and rejects stale callbacks', () => {
    const first = beginFeedback(undefined, target, NOW, 'first');
    const second = ready(first, NOW, 'second');
    const stale = first.pending!.token;
    expect(second.pending!.token).not.toBe(stale);
    expect(() => chooseFeedbackCategory(second, 'answer', NOW, stale)).toThrow();
    expect(() => submitFeedback(second, 'Описание', NOW, 'submit', stale)).toThrow();
    expect(() => cancelFeedback(second, stale)).toThrow();
    expect(second.reports).toHaveLength(0);
  });

  it('requires a valid category and expires after thirty minutes', () => {
    const start = beginFeedback(undefined, target, NOW);
    expect(() => submitFeedback(start, 'Описание', NOW, 'send')).toThrow();
    expect(() => chooseFeedbackCategory(start, '__proto__', NOW)).toThrow();
    expect(pendingFeedback(start, NOW + FEEDBACK_TTL_MS - 1)).toBeDefined();
    expect(pendingFeedback(start, NOW + FEEDBACK_TTL_MS)).toBeUndefined();
    expect(() => chooseFeedbackCategory(start, 'translation', NOW + FEEDBACK_TTL_MS)).toThrow();
  });

  it('stores an explicitly submitted description once, clears the wizard and does not mutate input', () => {
    const prepared = ready(), before = structuredClone(prepared);
    const { state, report } = submitFeedback(prepared, ' Оба варианта подходят. ', NOW, 'event-2', prepared.pending!.token);
    expect(report.description).toBe('Оба варианта подходят.');
    expect(report.category).toBe('ambiguous');
    expect(state.pending).toBeUndefined();
    expect(state.reports).toHaveLength(1);
    expect(prepared).toEqual(before);
    // The transaction can retry with identical input without producing a random ID.
    expect(submitFeedback(prepared, ' Оба варианта подходят. ', NOW, 'event-2').report.id).toBe(report.id);
    expect(() => submitFeedback(state, 'replay', NOW, 'event-2')).toThrow();
  });

  it('allows a category-only report, but never stores a command or an oversized text as its description', () => {
    const prepared = ready();
    expect(submitFeedback(prepared, undefined, NOW, 'no-description').report.description).toBe('');
    expect(() => submitFeedback(prepared, '/start', NOW, 'command')).toThrow();
    expect(() => submitFeedback(prepared, 'x'.repeat(1001), NOW, 'too-long')).toThrow();
    expect(submitFeedback(prepared, 'x'.repeat(1000), NOW, 'max-length').report.description).toHaveLength(1000);
    expect(prepared.reports).toHaveLength(0);
  });

  it('caps reports per user and cancellation preserves submitted reports', () => {
    let state: FeedbackState | undefined;
    for (let index = 0; index < FEEDBACK_LIMIT + 3; index++) {
      state = ready(state, NOW + index, `open-${index}`);
      state = submitFeedback(state, `Описание ${index}`, NOW + index, `submit-${index}`).state;
    }
    expect(state!.reports).toHaveLength(FEEDBACK_LIMIT);
    expect(state!.reports[0]!.description).toBe('Описание 3');
    const next = beginFeedback(state, target, NOW + 100, 'next');
    const cancelled = cancelFeedback(next, next.pending!.token);
    expect(cancelled.reports).toEqual(state!.reports);
    expect(cancelled.pending).toBeUndefined();
    expect(next.pending).toBeDefined();
  });

  it('renders owner-only pages from provided data, including the exact submitted options and clamped navigation', () => {
    const first = submitFeedback(ready(), 'Ошибка в переводе', NOW, 'first').state;
    const second = submitFeedback(ready(undefined, NOW + 1), undefined, NOW + 1, 'second').state;
    const reports = collectReports([{ userId: 1, feedback: first }, { userId: 2, feedback: second }, { userId: 3 }]);
    expect(reports).toHaveLength(2);
    const page = renderReportPage(reports, 500);
    expect(page).toMatchObject({ page: 1, pages: 2 });
    expect(page.text).toContain('Пользователь: 1');
    expect(page.text).toContain('1. Ա');
    expect(page.text).toContain('Ошибка в переводе');
    expect(page.text.length).toBeLessThan(4096);
    expect(renderReportPage([], -1).pages).toBe(0);
  });
});
