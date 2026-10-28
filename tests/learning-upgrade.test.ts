import { describe, expect, it, vi } from 'vitest';
import { loadCourse, type Course } from '../src/course.js';
import { LearningEngine, type BotEvent, type UserState } from '../src/engine.js';
import { MemoryStateStore } from '../src/storage.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const MINUTE = 60_000;
const DAY = 86_400_000;

function fixture(questionCount = 1): Course {
  const course = loadCourse();
  course.questions = course.questions.slice(0, questionCount).map(question => ({ ...question,
    readingHelp: [{ hy: 'Ո՞վ', ru: 'Кто', noteRu: 'Ищем действующее лицо или орган.' }], vocabularyIds: ['v001', 'v002'] }));
  course.vocabulary = course.vocabulary.slice(0, 6);
  course.lessons = [
    { id: 'general_first', titleRu: 'Общий словарь', introRu: 'Общие слова', examTrack: false, vocabularyIds: ['v003', 'v004'], questionIds: [] },
    { id: 'exam_core', titleRu: 'К экзамену', introRu: 'Основной маршрут', examTrack: true, vocabularyIds: ['v001', 'v002'], questionIds: course.questions.map(question => question.id) },
  ];
  return course;
}

function harness(course = fixture()) {
  const store = new MemoryStateStore();
  let sequence = 0;
  const makeEngine = () => new LearningEngine({ store, course, accessMode: 'public', allowedUserIds: [], adminUserIds: [1] });
  let engine = makeEngine();
  const state = async (userId = 2): Promise<UserState> => store.update(`u_${userId}`, raw => {
    if (!raw) throw new Error('Expected stored user');
    return { state: raw, result: structuredClone(raw) as UserState };
  });
  const event = (input: Partial<BotEvent> = {}): BotEvent => {
    const userId = input.userId ?? 2;
    return { userId, chatId: userId, now: NOW, eventId: `upgrade-${++sequence}`, ...input };
  };
  const send = async (input: Partial<BotEvent> = {}) => {
    const deliveries = await engine.handle(event(input));
    for (const delivery of deliveries) await engine.acknowledge(delivery.userId, delivery.id);
    return deliveries.at(-1)?.view;
  };
  const edit = async (callback: (user: UserState) => void, userId = 2) => store.update(`u_${userId}`, raw => {
    if (!raw) throw new Error('Expected stored user');
    callback(raw as UserState); return { state: raw, result: undefined };
  });
  const question = async (userId = 2) => {
    const session = (await state(userId)).session!;
    const step = session.steps[session.index]!;
    if (step.kind !== 'question') throw new Error('Expected a question');
    return { session, step };
  };
  const answer = async (correct = true, now = NOW) => {
    const { session, step } = await question();
    const selected = correct ? step.question.correctIndex : (step.question.correctIndex + 1) % step.question.options.length;
    return send({ action: `answer:${session.id}:${session.index}:${selected}`, now });
  };
  const openReport = async (now = NOW, category = 'ambiguous') => {
    const session = (await state()).session!;
    await send({ action: `report:${session.id}:${session.index}`, now });
    const token = (await state()).feedback!.pending!.token;
    await send({ action: `feedback:${token}:category:${category}`, now });
    return token;
  };
  return { store, course, state, event, send, edit, question, answer, openReport,
    get engine() { return engine; }, restart() { engine = makeEngine(); } };
}

describe('owner analytics and report access', () => {
  it.each([{ text: '/stats' }, { text: '/reports' }, { text: '/stats@amtest53_bot' }, { action: 'admin:stats' },
    { action: 'admin:reports:0' }, { action: 'admin:users:0' }, { action: 'admin:questions:0' }])('never scans other users for an unprivileged request %j', async input => {
    const h = harness();
    const scan = vi.spyOn(h.store, 'listPage');
    const response = await h.send(input);
    expect(response?.text).toContain('только администратору');
    expect(scan).not.toHaveBeenCalled();
    expect(response?.text).not.toContain('Пользователей:');
  });

  it('shows the owner real accepted answers, assistance and submitted reports', async () => {
    const h = harness();
    await h.send({ action: 'menu:practice' });
    const { session } = await h.question();
    await h.send({ action: `hint:${session.id}:0` });
    await h.answer();
    await h.openReport();
    await h.send({ text: 'Два варианта кажутся одинаковыми.' });
    const stats = await h.send({ userId: 1, text: '/stats' });
    expect(stats?.text).toContain('Пользователей: 2');
    expect(stats?.text).toContain('Ответы с подсказкой: 100% (1/1)');
    expect(stats?.text).toContain('Начатые / завершённые занятия: 1 / 0');
    const reports = await h.send({ userId: 1, text: '/reports' });
    expect(reports?.text).toContain('Два варианта кажутся одинаковыми.');
    expect(reports?.text).toContain('Пользователь: 2');
    expect(reports?.text).toContain(h.course.questions[0]!.id);
  });

  it('scans all pages beyond 1000 users without using the capped legacy list', async () => {
    const h = harness();
    await h.send({ userId: 1, text: '/start' });
    const template = await h.state(1);
    await Promise.all(Array.from({ length: 1004 }, (_, index) => {
      const id = index + 2;
      return h.store.update(`u_${id}`, () => ({ state: { ...structuredClone(template), userId: id, chatId: id }, result: undefined }));
    }));
    await h.store.update('u_99999', () => ({ state: null, result: undefined }));
    const pages = vi.spyOn(h.store, 'listPage');
    const legacy = vi.spyOn(h.store, 'list');
    const view = await h.send({ userId: 1, text: '/stats' });
    expect(view?.text).toContain('Пользователей: 1005');
    expect(pages).toHaveBeenCalledTimes(11);
    expect(legacy).not.toHaveBeenCalled();
    expect(new Set(pages.mock.calls.map(([, options]) => options?.afterKey)).size).toBe(11);
  });
});

describe('deduplication and explicit feedback', () => {
  it('does not duplicate session starts, hints, answers or reports when Telegram retries events', async () => {
    const h = harness();
    const start = h.event({ action: 'menu:practice' });
    await h.send(start); const original = (await h.state()).session!;
    await h.send(start);
    expect((await h.state()).session!.id).toBe(original.id);
    const hint = h.event({ action: `hint:${original.id}:0` });
    await h.send(hint); await h.send(hint);
    const { step } = await h.question();
    const answer = h.event({ action: `answer:${original.id}:0:${step.question.correctIndex}` });
    await h.send(answer); await h.send(answer);
    await h.openReport();
    const report = h.event({ text: 'Проверить перевод.' });
    await h.send(report); await h.send(report);
    const stored = await h.state(), day = stored.analytics!.days['2026-10-28']!;
    expect(day).toMatchObject({ starts: 1, hints: 1, answers: 1, hintedAnswers: 1 });
    expect(stored.attempts).toBe(1);
    expect(stored.feedback!.reports).toHaveLength(1);
  });

  it('captures the displayed snapshot and rejects buttons from a replaced report wizard', async () => {
    const h = harness();
    await h.send({ action: 'menu:practice' });
    const { session, step } = await h.question();
    h.course.questions[0]!.promptHy = 'Changed after the session started';
    h.course.questions[0]!.options.reverse();
    const firstToken = await h.openReport();
    const captured = (await h.state()).feedback!.pending!.target;
    expect(captured).toMatchObject({ id: step.question.id, contentVersion: session.contentVersion, prompt: step.question.promptHy,
      options: step.question.options.map(option => option.hy) });
    expect(Object.keys(captured)).not.toContain('correctIndex');
    const newToken = await h.openReport();
    expect(newToken).not.toBe(firstToken);
    const pending = (await h.state()).feedback!.pending;
    for (const suffix of ['category:translation', 'submit', 'cancel']) {
      const response = await h.send({ action: `feedback:${firstToken}:${suffix}` });
      expect(response?.text).toContain('устарели');
      expect((await h.state()).feedback!.pending).toEqual(pending);
      expect((await h.state()).feedback!.reports).toHaveLength(0);
    }
  });

  it('keeps an overlong description editable, and commands or cancellation never become report text', async () => {
    const h = harness();
    await h.send({ action: 'menu:practice' });
    await h.openReport();
    const tooLong = await h.send({ text: 'я'.repeat(1001) });
    expect(tooLong?.text).toContain('слишком длинное');
    expect((await h.state()).feedback!.reports).toHaveLength(0);
    expect((await h.state()).feedback!.pending).toBeDefined();
    await h.send({ text: '/cancel' });
    expect((await h.state()).feedback!.pending).toBeUndefined();
    await h.openReport();
    await h.send({ text: '/progress' });
    expect((await h.state()).feedback!.pending).toBeUndefined();
    expect((await h.state()).feedback!.reports).toHaveLength(0);
    await h.openReport();
    await h.send({ text: '\u0000/start' });
    expect((await h.state()).feedback!.pending).toBeUndefined();
    expect((await h.state()).feedback!.reports).toHaveLength(0);
    await h.openReport();
    await h.send({ text: 'я'.repeat(1000) });
    expect((await h.state()).feedback!.reports[0]!.description).toHaveLength(1000);
  });

  it('keeps an exam timer running and stores a report submitted exactly at its deadline', async () => {
    const course = loadCourse();
    course.questions.forEach(question => { question.readingHelp = [{ hy: 'Ո՞վ', ru: 'Кто', noteRu: 'Ищем орган.' }]; });
    const h = harness(course);
    await h.send({ action: 'start:exam' });
    const { session, step } = await h.question();
    const deadline = session.deadlineAt!;
    const hidden = await h.send({ action: `reading:${session.id}:0`, now: NOW + MINUTE });
    expect(hidden?.text).not.toContain('Разбор вопроса:');
    expect(hidden?.text).not.toContain('Перевод вопроса:');
    await h.openReport(deadline - MINUTE);
    const before = (await h.state()).session!;
    expect(before.deadlineAt).toBe(deadline);
    expect(before.index).toBe(0);
    expect(before.hints).toHaveLength(0);
    expect(before.readingHints).toHaveLength(0);
    const sent = await h.send({ text: 'Неточность в вопросе.', now: deadline });
    const after = await h.state();
    expect(sent?.text).toContain('сохранено');
    expect(sent?.text).not.toContain(step.question.explanationRu);
    expect(after.feedback!.reports[0]!.target.options).toEqual(step.question.options.map(option => option.hy));
    expect(after.session!.deadlineAt).toBe(deadline);
    expect(after.session!.endedAt).toBe(deadline);
    expect(after.exams).toHaveLength(1);
    expect(after.exams[0]).toMatchObject({ score: 0, timedOut: true });
  });
});

describe('learning upgrade persistence and scheduling', () => {
  it('resets learning while preserving usage, submitted reports, creation time and replay protection', async () => {
    const h = harness();
    const start = h.event({ action: 'menu:practice', now: NOW - DAY });
    await h.send(start);
    await h.answer(false);
    await h.openReport();
    await h.send({ text: 'Текст сообщения сохраняется.' });
    await h.openReport();
    await h.edit(user => {
      user.cards.v001 = { level: 2, dueAt: NOW + DAY, seen: 4, mistakes: 1 };
      user.completedLessons = ['exam_core'];
      user.exams = [{ at: NOW, score: 20, total: 33, timedOut: false, version: h.course.version }];
      user.reminders.enabled = true;
    });
    const before = await h.state();
    await h.send({ action: 'reset:confirm' });
    const after = await h.state();
    expect(after).toMatchObject({ createdAt: before.createdAt, session: null, cards: {}, questionProgress: {}, questionMistakes: {},
      completedLessons: [], attempts: 0, correct: 0, exams: [], reminders: { enabled: false } });
    expect(after.analytics).toEqual(before.analytics);
    expect(after.feedback!.reports).toEqual(before.feedback!.reports);
    expect(after.feedback!.pending).toBeUndefined();
    expect(after.processedEvents).toEqual(expect.arrayContaining(before.processedEvents));
    await h.send(start);
    expect((await h.state()).session).toBeNull();
    expect((await h.state()).attempts).toBe(0);
  });

  it('loads legacy state without new fields and records a first assisted question safely', async () => {
    const h = harness();
    await h.send({ action: 'menu:practice' });
    await h.edit(user => { delete user.analytics; delete user.feedback; delete user.questionProgress; delete user.session!.readingHints; });
    h.restart();
    const original = (await h.state()).session!;
    const resumed = await h.send({ action: 'menu:continue' });
    expect(resumed?.text).toContain('1/1');
    expect((await h.state()).session!.id).toBe(original.id);
    await h.send({ action: `reading:${original.id}:0` });
    await h.answer();
    const stored = await h.state();
    expect(stored.analytics!.days['2026-10-28']!.answers).toBe(1);
    expect(stored.questionProgress![h.course.questions[0]!.id]).toMatchObject({ level: 0, successfulDays: 0 });
  });

  it('treats question reading help as assistance without advancing or awarding mastery', async () => {
    const h = harness();
    await h.send({ action: 'menu:practice' });
    const { session, step } = await h.question();
    const view = await h.send({ action: `reading:${session.id}:0` });
    expect(view?.text).toContain('Разбор вопроса:');
    expect((await h.state()).session!.index).toBe(0);
    expect((await h.state()).session!.answers).toHaveLength(0);
    await h.send({ action: `reading:${session.id}:0` });
    await h.send({ action: `hint:${session.id}:0` });
    await h.answer();
    const stored = await h.state();
    expect(stored.correct).toBe(0);
    expect(stored.session!.answers[0]).toMatchObject({ correct: true, hinted: true });
    expect(stored.questionProgress![step.question.id]).toMatchObject({ level: 0, dueAt: NOW + 10 * MINUTE, successfulDays: 0 });
    expect(stored.analytics!.days['2026-10-28']).toMatchObject({ hints: 1, hintedAnswers: 1, correctUnhinted: 0 });
  });

  it('uses only the exam path and core vocabulary even when the general lesson and due word come first', async () => {
    const h = harness();
    await h.send({ text: '/start' });
    await h.edit(user => { user.cards.v003 = { level: 1, dueAt: NOW - 1, seen: 1, mistakes: 0 }; });
    await h.send({ action: 'menu:today' });
    const session = (await h.state()).session!;
    expect(session.lessonId).toBe('exam_core');
    expect(session.steps.filter(step => step.kind === 'word').map(step => step.word.id)).toEqual(['v001', 'v002']);
    await h.send({ action: 'menu:exam_words' });
    const lexicon = (await h.state()).session!;
    expect(lexicon.title).toBe('Лексика экзамена');
    expect(lexicon.steps.every(step => step.kind === 'word' && ['v001', 'v002'].includes(step.word.id))).toBe(true);
  });

  it('returns a failed question after ten minutes and does not advance its interval through early extra practice', async () => {
    const h = harness();
    await h.send({ action: 'menu:practice' });
    await h.answer(false);
    const questionId = h.course.questions[0]!.id;
    expect((await h.state()).questionProgress![questionId]).toMatchObject({ level: 0, dueAt: NOW + 10 * MINUTE });
    const early = await h.send({ action: 'menu:question_review', now: NOW + 9 * MINUTE });
    expect(early?.text).toContain('повторению сейчас нет');
    await h.send({ action: 'menu:question_review', now: NOW + 10 * MINUTE });
    await h.answer(true, NOW + 10 * MINUTE);
    const first = (await h.state()).questionProgress![questionId]!;
    expect(first).toMatchObject({ level: 1, successfulDays: 1, dueAt: NOW + 10 * MINUTE + DAY });
    await h.send({ action: 'menu:practice', now: NOW + 11 * MINUTE });
    await h.answer(true, NOW + 11 * MINUTE);
    expect((await h.state()).questionProgress![questionId]).toMatchObject({ level: 1, successfulDays: 1, dueAt: first.dueAt, seen: 3 });
  });

  it('adds due questions to the next path lesson without duplicating its own questions', async () => {
    const course = fixture(3);
    course.lessons[1]!.questionIds = [course.questions[0]!.id];
    const h = harness(course);
    await h.send({ text: '/start' });
    await h.edit(user => {
      user.questionProgress = Object.fromEntries(course.questions.slice(0, 2).map(question => [question.id, {
        seen: 1, mistakes: 1, level: 0, dueAt: NOW - 1, successfulDays: 0, lastAnsweredAt: NOW - MINUTE, lastSuccessfulDay: null,
      }]));
    });
    await h.send({ action: 'menu:path_next' });
    const session = (await h.state()).session!;
    const ids = session.steps.filter(step => step.kind === 'question').map(step => step.question.id);
    expect(session.lessonId).toBe('exam_core');
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set(course.questions.slice(0, 2).map(question => question.id)));
  });

  it('keeps due core words and questions in the daily route after all exam lessons are completed', async () => {
    const h = harness(fixture(2));
    await h.send({ text: '/start' });
    await h.edit(user => {
      user.completedLessons = ['exam_core'];
      user.cards.v001 = { level: 1, dueAt: NOW - 1, seen: 1, mistakes: 0 };
      user.cards.v003 = { level: 1, dueAt: NOW - 1, seen: 1, mistakes: 0 };
      user.questionProgress = { [h.course.questions[1]!.id]: {
        seen: 1, mistakes: 1, level: 0, dueAt: NOW - 1, successfulDays: 0, lastAnsweredAt: NOW - MINUTE, lastSuccessfulDay: null,
      } };
    });
    await h.send({ action: 'menu:path_next' });
    const session = (await h.state()).session!;
    expect(session.kind).toBe('review');
    expect(session.lessonId).toBeNull();
    expect(session.steps.filter(step => step.kind === 'word').map(step => step.word.id)).toEqual(['v001']);
    expect(session.steps.filter(step => step.kind === 'question').map(step => step.question.id)).toEqual([h.course.questions[1]!.id]);
  });

  it('records a scheduler timeout without making the user active on a new UTC day, and only completes once', async () => {
    const h = harness(loadCourse());
    const start = Date.parse('2026-10-28T23:30:00Z');
    await h.send({ action: 'start:exam', now: start });
    const deadline = (await h.state()).session!.deadlineAt!;
    await h.engine.maintenance(deadline);
    await h.engine.maintenance(deadline + MINUTE);
    const stored = await h.state();
    expect(stored.updatedAt).toBe(start);
    expect(stored.analytics!.days['2026-10-28']!.active).toBe(1);
    expect(stored.analytics!.days['2026-10-29']).toMatchObject({ active: 0, completed: 1, exams: 1 });
    expect(stored.exams).toHaveLength(1);
  });
});
