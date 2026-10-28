import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCourse } from '../src/course.js';
import { LearningEngine, type BotEvent, type MessageView, type PendingDelivery, type StudySession, type UserState } from '../src/engine.js';
import { MemoryStateStore } from '../src/storage.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const MINUTE = 60_000;
const DAY = 86_400_000;

function harness(course = loadCourse(), accessMode: 'private' | 'public' = 'private') {
  const store = new MemoryStateStore();
  let sequence = 0;
  const makeEngine = (allowedUserIds = [1, 2], adminUserIds: number[] = [], mode = accessMode) =>
    new LearningEngine({ store, course, allowedUserIds, adminUserIds, accessMode: mode });
  let engine = makeEngine();
  const state = async (userId = 1) => store.update(`u_${userId}`, raw => ({
    state: raw, result: structuredClone(raw) as UserState | null,
  }));
  const session = async (userId = 1): Promise<StudySession> => {
    const current = (await state(userId))?.session;
    if (!current) throw new Error('Expected a study session');
    return current;
  };
  const event = (input: Partial<BotEvent> = {}): BotEvent => ({
    userId: 1, chatId: 1, eventId: `test-${++sequence}`, now: NOW, ...input,
  });
  const acknowledge = async (deliveries: PendingDelivery[]) => {
    for (const delivery of deliveries) await engine.acknowledge(delivery.userId, delivery.id);
  };
  const send = async (input: Partial<BotEvent> = {}) => {
    const deliveries = await engine.handle(event(input));
    const view = deliveries.at(-1)?.view;
    await acknowledge(deliveries);
    return view;
  };
  const answer = async (correct = true, now = NOW, userId = 1) => {
    const current = await session(userId);
    const step = current.steps[current.index]!;
    const correctIndex = step.kind === 'word' ? step.correctIndex : step.question.correctIndex;
    const count = step.kind === 'word' ? step.choices.length : step.question.options.length;
    return send({ userId, chatId: userId, now,
      action: `answer:${current.id}:${current.index}:${correct ? correctIndex : (correctIndex + 1) % count}` });
  };
  const next = async (now = NOW) => {
    const current = await session();
    return send({ now, action: `next:${current.id}:${current.index}` });
  };
  return { store, course, state, session, event, send, answer, next, acknowledge,
    get engine() { return engine; },
    restart: (allowed = [1, 2], admins: number[] = [], mode = accessMode) => { engine = makeEngine(allowed, admins, mode); },
  };
}

afterEach(() => vi.restoreAllMocks());

function categoryCourse() {
  const course = loadCourse();
  course.vocabulary.forEach((word, index) => {
    delete word.category;
    if (index < 12) word.category = 'nouns';
    else if (index < 24) word.category = 'verbs';
    else if (index < 28) word.category = 'other';
  });
  return course;
}

describe('large vocabulary navigation', () => {
  it('shows only available categories and keeps the all-words and lessons entries', async () => {
    const course = categoryCourse();
    const h = harness(course);
    const first = (await h.send({ text: '/start' }))?.buttons?.flat() ?? [];
    expect(first).toContainEqual({ text: 'Существительные', data: 'menu:nouns' });
    expect(first).toContainEqual({ text: 'Глаголы', data: 'menu:verbs' });
    expect(first).toContainEqual({ text: 'Другие слова', data: 'menu:other' });
    expect(first).toContainEqual({ text: 'Уроки', data: 'menu:lessons' });
    expect(first).toContainEqual({ text: 'Слова', data: 'menu:words' });
    course.vocabulary.forEach(word => { delete word.category; });
    const second = (await h.send({ text: '/start' }))?.buttons?.flat() ?? [];
    expect(second.some(item => ['menu:nouns', 'menu:verbs', 'menu:other'].includes(item.data))).toBe(false);
    const empty = await h.send({ action: 'menu:nouns' });
    expect(empty?.text).toContain('Существительные');
    expect(empty?.text).toContain('пока нет слов');
    expect((await h.state())?.session).toBeNull();
  });

  it.each(['nouns', 'verbs', 'other'] as const)('selects only due or unseen %s, prioritizes due cards and caps the session at ten words', async category => {
    const h = harness(categoryCourse());
    await h.send({ text: '/start' });
    const words = h.course.vocabulary.filter(word => word.category === category);
    const due = words.at(-1)!;
    const early = words[0]!;
    const other = h.course.vocabulary.find(word => word.category !== category)!;
    await h.store.update('u_1', raw => {
      const user = raw as UserState;
      user.cards[due.id] = { level: 1, dueAt: NOW, seen: 1, mistakes: 0 };
      user.cards[early.id] = { level: 1, dueAt: NOW + DAY, seen: 1, mistakes: 0 };
      user.cards[other.id] = { level: 1, dueAt: NOW, seen: 1, mistakes: 0 };
      return { state: user, result: undefined };
    });
    await h.send({ action: `menu:${category}` });
    const session = await h.session();
    expect(session.steps).toHaveLength(Math.min(words.length - 1, 10));
    expect(session.steps[0]).toMatchObject({ kind: 'word', word: { id: due.id } });
    for (const step of session.steps) {
      expect(step.kind).toBe('word');
      if (step.kind !== 'word') throw new Error('Expected word');
      expect(step.word.category).toBe(category);
      expect(step.word.id).not.toBe(early.id);
      expect(step.word.id).not.toBe(other.id);
    }
    await h.send({ action: 'menu:words' });
    const allIds = (await h.session()).steps.map(step => step.kind === 'word' ? step.word.id : '');
    expect(allIds).toContain(due.id);
    expect(allIds).toContain(other.id);
  });

  it('explains an exhausted category without replacing the current session', async () => {
    const h = harness(categoryCourse());
    await h.send({ action: 'menu:practice' });
    const original = await h.session();
    await h.store.update('u_1', raw => {
      const user = raw as UserState;
      for (const word of h.course.vocabulary.filter(item => item.category === 'verbs')) {
        user.cards[word.id] = { level: 1, dueAt: NOW + DAY, seen: 1, mistakes: 0 };
      }
      return { state: user, result: undefined };
    });
    const view = await h.send({ action: 'menu:verbs' });
    expect(view?.text).toContain('Глаголы');
    expect(view?.text).toContain('Повторений на сейчас нет');
    expect(await h.session()).toEqual(original);
  });

  it('pages through every lesson exactly once with at most eight lesson buttons and working navigation', async () => {
    const course = categoryCourse();
    course.lessons = Array.from({ length: 53 }, (_, index) => ({
      id: `page_l${index + 1}`, titleRu: `Урок ${index + 1}`, introRu: 'Короткое занятие.',
      vocabularyIds: [course.vocabulary[index % course.vocabulary.length]!.id], questionIds: [],
    }));
    const h = harness(course);
    const visited: string[] = [];
    let action: string | undefined = 'menu:lessons';
    let page = 0;
    while (action) {
      const view = await h.send({ action });
      expect(view?.text).toContain(`страница ${page + 1}/7`);
      expect(view?.text.length).toBeLessThanOrEqual(4096);
      expect(view?.buttons?.length).toBeLessThanOrEqual(10);
      const buttons = view?.buttons?.flat() ?? [];
      const lessons = buttons.filter(item => item.data.startsWith('lesson:'));
      expect(lessons.length).toBeGreaterThan(0);
      expect(lessons.length).toBeLessThanOrEqual(8);
      for (const item of buttons) expect(Buffer.byteLength(item.data, 'utf8')).toBeLessThanOrEqual(64);
      visited.push(...lessons.map(item => item.data.slice('lesson:'.length)));
      expect(buttons.some(item => item.data === `menu:lessons:${page - 1}`)).toBe(page > 0);
      action = buttons.find(item => item.data === `menu:lessons:${page + 1}`)?.data;
      page++;
      expect(page).toBeLessThanOrEqual(7);
    }
    expect(visited).toEqual(course.lessons.map(lesson => lesson.id));
    const last = course.lessons.at(-1)!;
    await h.send({ action: `lesson:${last.id}` });
    expect((await h.session()).steps).toHaveLength(1);
    expect((await h.session()).steps[0]?.kind).toBe('word');
    await h.answer();
    await h.next();
    const finalPage = await h.send({ action: 'menu:lessons:6' });
    expect(finalPage?.buttons?.flat()).toContainEqual({ text: `✓ ${last.titleRu}`, data: `lesson:${last.id}` });
    expect((await h.state())?.completedLessons).toEqual([last.id]);
    expect((await h.session()).endedAt).not.toBeNull();
  });

  it.each(['-1', 'NaN', 'Infinity', '1.5', 'abc', '1:2'])('uses the first page for an invalid lesson page %s', async value => {
    const h = harness();
    const view = await h.send({ action: `menu:lessons:${value}` });
    expect(view?.text).toContain('страница 1/');
    expect(view?.buttons?.flat().filter(item => item.data.startsWith('lesson:')).map(item => item.data))
      .toEqual(h.course.lessons.slice(0, 8).map(lesson => `lesson:${lesson.id}`));
  });

  it('clamps a requested page beyond the end to the final page', async () => {
    const h = harness();
    const pages = Math.ceil(h.course.lessons.length / 8);
    const view = await h.send({ action: 'menu:lessons:999999' });
    expect(view?.text).toContain(`страница ${pages}/${pages}`);
    expect(view?.buttons?.flat().filter(item => item.data.startsWith('lesson:')).map(item => item.data))
      .toEqual(h.course.lessons.slice((pages - 1) * 8).map(lesson => `lesson:${lesson.id}`));
  });

  it('excludes alternate glosses of the same Armenian headword and overlapping merged Russian translations', async () => {
    const course = loadCourse();
    course.vocabulary = [
      { id: 'target', hy: 'լավ', ru: 'хорошо; ладно' },
      { id: 'same_head', hy: ' ԼԱՎ ', ru: 'приятно' },
      { id: 'overlap_one', hy: 'բարի', ru: 'хорошо' },
      { id: 'overlap_two', hy: 'այո', ru: 'ЛАДНО / да' },
      { id: 'overlap_three', hy: 'գեղեցիկ', ru: 'красиво, Хорошо' },
      { id: 'tree', hy: 'ծառ', ru: 'дерево' },
      { id: 'water', hy: 'ջուր', ru: 'вода' },
      { id: 'house', hy: 'տուն', ru: 'дом' },
    ];
    course.lessons = [{ id: 'gloss_lesson', titleRu: 'Синонимы', introRu: 'Выберите перевод.', vocabularyIds: ['target'], questionIds: [] }];
    const h = harness(course);
    for (let index = 0; index < 5; index++) {
      await h.send({ action: 'lesson:gloss_lesson' });
      const step = (await h.session()).steps[0]!;
      if (step.kind !== 'word') throw new Error('Expected word');
      expect(new Set(step.choices)).toEqual(new Set(['хорошо; ладно', 'дерево', 'вода', 'дом']));
      expect(step.choices[step.correctIndex]).toBe('хорошо; ладно');
    }
  });
});

describe('study sessions', () => {
  it.each(['lesson:l001', 'menu:practice', 'start:exam'])('shuffles question choices for %s without changing the correct answer or published bank', async action => {
    const h = harness();
    const published = structuredClone(h.course.questions);
    const orders = new Map<string, Set<string>>();
    for (let run = 0; run < 8; run++) {
      await h.send({ action });
      for (const step of (await h.session()).steps) {
        if (step.kind === 'word') {
          expect(step.choices).toHaveLength(4);
          expect(step.choices[step.correctIndex]).toBe(step.word.ru);
          continue;
        }
        const original = published.find(question => question.id === step.question.id)!;
        expect(step.question.options).toHaveLength(4);
        expect(step.question.options[step.question.correctIndex]).toEqual(original.options[original.correctIndex]);
        const variants = orders.get(original.id) ?? new Set<string>();
        variants.add(JSON.stringify(step.question.options));
        orders.set(original.id, variants);
      }
    }
    expect([...orders.values()].some(variants => variants.size > 1)).toBe(true);
    expect(h.course.questions).toEqual(published);
  });

  it.each(['word', 'question'] as const)('accepts the fourth %s choice and awards the correct result', async kind => {
    const h = harness();
    await h.send({ action: kind === 'word' ? 'menu:words' : 'menu:practice' });
    await h.store.update('u_1', raw => {
      const user = raw as UserState, step = user.session!.steps[0]!;
      if (step.kind === 'word') {
        const correct = step.choices.splice(step.correctIndex, 1)[0]!;
        step.choices.push(correct); step.correctIndex = 3;
      } else {
        const correct = step.question.options.splice(step.question.correctIndex, 1)[0]!;
        step.question.options.push(correct); step.question.correctIndex = 3;
      }
      return { state: user, result: undefined };
    });
    const current = await h.session();
    const resumed = await h.send({ action: 'menu:continue' });
    expect(resumed?.buttons?.[0]?.map(button => button.text)).toEqual(['1', '2', '3', '4']);
    await h.send({ action: `answer:${current.id}:0:3` });
    expect((await h.session()).answers[0]).toMatchObject({ selected: 3, correct: true });
    expect((await h.state())?.correct).toBe(1);
  });

  it.each(['word', 'question'] as const)('continues a saved three-choice %s snapshot after the four-choice upgrade', async kind => {
    const h = harness();
    await h.send({ action: kind === 'word' ? 'menu:words' : 'menu:practice' });
    await h.store.update('u_1', raw => {
      const user = raw as UserState, step = user.session!.steps[0]!;
      user.session!.contentVersion = 'legacy-three-choices';
      if (step.kind === 'word') {
        const correct = step.choices[step.correctIndex]!;
        step.choices = [...step.choices.filter((_, index) => index !== step.correctIndex).slice(0, 2), correct];
        step.correctIndex = 2;
      } else {
        const correct = step.question.options[step.question.correctIndex]!;
        step.question.options = [...step.question.options.filter((_, index) => index !== step.question.correctIndex).slice(0, 2), correct];
        step.question.correctIndex = 2;
      }
      return { state: user, result: undefined };
    });
    const original = await h.session();
    h.course.version = 'future-four-choices';
    h.course.questions.forEach(question => { question.promptHy = 'changed after session creation'; });
    h.course.vocabulary.forEach(word => { word.ru = `changed ${word.id}`; });
    h.restart();
    const view = await h.send({ action: 'menu:continue' });
    expect(view?.buttons?.[0]?.map(button => button.text)).toEqual(['1', '2', '3']);
    expect(await h.session()).toEqual(original);
    await h.send({ action: `answer:${original.id}:0:3` });
    expect((await h.state())?.attempts).toBe(0);
    await h.send({ action: `answer:${original.id}:0:2` });
    expect((await h.session()).answers[0]).toMatchObject({ selected: 2, correct: true });
    expect((await h.state())?.correct).toBe(1);
  });

  it('shows translation without advancing or awarding progress, then records the hinted answer', async () => {
    const h = harness();
    await h.send({ action: 'menu:practice' });
    const original = await h.session();
    const step = original.steps[0]!;
    expect(step.kind).toBe('question');
    const view = await h.send({ action: `hint:${original.id}:0` });
    if (step.kind !== 'question') throw new Error('Expected question');
    expect(view?.text).toContain(step.question.promptRu);
    expect((await h.session()).index).toBe(0);
    expect((await h.session()).answers).toEqual([]);
    expect((await h.state())?.attempts).toBe(0);
    await h.send({ action: `hint:${original.id}:0` });
    expect((await h.session()).hints).toEqual([0]);
    await h.answer();
    expect((await h.state())?.correct).toBe(0);
    expect((await h.state())?.attempts).toBe(1);
    expect((await h.session()).answers[0]).toMatchObject({ correct: true, hinted: true });
    expect((await h.session()).index).toBe(0);
    await h.next();
    expect((await h.session()).index).toBe(1);
  });

  it('deduplicates Telegram updates and rejects repeated or stale buttons', async () => {
    const h = harness();
    const start = h.event({ action: 'menu:practice' });
    const first = await h.engine.handle(start);
    const original = await h.session();
    expect(await h.engine.handle(start)).toEqual(first);
    expect((await h.state())?.outbox).toHaveLength(1);
    await h.acknowledge(first);
    expect(await h.engine.handle(start)).toEqual([]);
    const step = original.steps[0]!;
    if (step.kind !== 'question') throw new Error('Expected question');
    const answer = h.event({ action: `answer:${original.id}:0:${step.question.correctIndex}` });
    const result = await h.engine.handle(answer);
    expect(await h.engine.handle(answer)).toEqual(result);
    await h.acknowledge(result);
    await h.send({ action: answer.action });
    expect((await h.state())?.attempts).toBe(1);
    await h.next();
    const stale = await h.send({ action: answer.action });
    expect(stale?.text).toContain('устарела');
    await h.send({ action: `next:${original.id}:0` });
    expect((await h.session()).index).toBe(1);
    expect((await h.state())?.attempts).toBe(1);
  });

  it('does not skip unanswered cards and ignores out-of-range answer indices', async () => {
    const h = harness();
    await h.send({ action: 'menu:practice' });
    const session = await h.session();
    await h.next();
    for (const selected of ['-1', '4', 'NaN', '1.5']) {
      await h.send({ action: `answer:${session.id}:0:${selected}` });
    }
    expect((await h.session()).index).toBe(0);
    expect((await h.session()).answers).toEqual([]);
    expect((await h.state())?.attempts).toBe(0);
  });

  it('resumes the exact session snapshot after engine recreation and course edits', async () => {
    const course = loadCourse();
    const h = harness(course);
    await h.send({ action: 'menu:practice' });
    await h.answer(false);
    const original = await h.session();
    course.version = 'future-version';
    course.questions.forEach(question => { question.promptHy = 'changed'; });
    h.restart();
    await h.send({ action: 'menu:today', now: NOW + MINUTE });
    expect(await h.session()).toEqual(original);
    expect((await h.state())?.attempts).toBe(1);
    await h.next();
    expect((await h.session()).index).toBe(1);
  });

  it('only completes a lesson after its final feedback is acknowledged', async () => {
    const h = harness();
    await h.send({ action: 'lesson:l001' });
    const original = await h.session();
    for (let index = 0; index < original.steps.length; index++) {
      await h.answer(index % 2 === 0);
      expect((await h.state())?.completedLessons).toEqual([]);
      await h.next();
    }
    expect((await h.state())?.completedLessons).toEqual(['l001']);
    expect((await h.session()).endedAt).toBe(NOW);
    await h.send({ action: 'menu:today' });
    expect((await h.session()).lessonId).toBe('l002');
  });

  it('renders every lesson, hint and explanation within Telegram message and callback limits', async () => {
    const h = harness();
    const check = (view: MessageView | undefined) => {
      expect(view).toBeDefined();
      expect(view!.text.length).toBeGreaterThan(0);
      expect(view!.text.length).toBeLessThanOrEqual(4096);
      for (const button of view!.buttons?.flat() ?? []) {
        expect(Buffer.byteLength(button.data, 'utf8')).toBeLessThanOrEqual(64);
      }
    };
    for (const lesson of h.course.lessons) {
      check(await h.send({ action: `lesson:${lesson.id}` }));
      const original = await h.session();
      for (let index = 0; index < original.steps.length; index++) {
        check(await h.send({ action: `hint:${original.id}:${index}` }));
        check(await h.answer(index % 2 === 0));
        check(await h.next());
      }
      for (let index = 0; index < original.steps.length; index++) {
        check(await h.send({ action: `mistakes:${original.id}:${index}` }));
      }
    }
    expect((await h.state())?.completedLessons).toHaveLength(h.course.lessons.length);
  }, 90_000); // Exhaustive rendering covers the entire imported corpus, including every explanation.
});

describe('33-question examination', () => {
  it.each([16, 17])('scores %i correct answers against the 17/33 threshold', async score => {
    const h = harness();
    const view = await h.send({ action: 'start:exam' });
    const original = await h.session();
    expect(original.steps).toHaveLength(33);
    expect(new Set(original.steps.map(step => step.kind === 'question' && step.question.id)).size).toBe(33);
    expect(original.deadlineAt).toBe(NOW + 60 * MINUTE);
    expect(view?.buttons?.flat().some(button => button.data.startsWith('hint:'))).toBe(false);
    const first = original.steps[0]!;
    if (first.kind !== 'question') throw new Error('Expected question');
    expect(view?.text).not.toContain(first.question.promptRu);
    await h.send({ action: `hint:${original.id}:0` });
    expect((await h.session()).hints).toEqual([]);
    let finalView = view;
    for (let index = 0; index < 33; index++) {
      finalView = await h.answer(index < score, NOW + (index + 1) * 1000);
    }
    expect((await h.session()).answers).toHaveLength(33);
    expect((await h.session()).endedAt).not.toBeNull();
    expect((await h.state())?.exams).toEqual([expect.objectContaining({ score, total: 33, timedOut: false })]);
    expect(finalView?.text).toContain(`${score}/33`);
    expect(finalView?.text).toContain(score === 17 ? 'Проходной результат тренировочного теста достигнут.' : 'Проходной результат пока не достигнут.');
    await h.send({ action: `answer:${original.id}:32:0` });
    expect((await h.state())?.exams).toHaveLength(1);
    expect((await h.state())?.attempts).toBe(33);
  });

  it('retains its absolute deadline on restart and rejects an answer exactly at expiry', async () => {
    const h = harness();
    await h.send({ action: 'start:exam' });
    await h.answer(true, NOW + MINUTE);
    const original = await h.session();
    h.restart();
    await h.send({ action: 'menu:continue', now: NOW + 59 * MINUTE });
    expect((await h.session()).deadlineAt).toBe(original.deadlineAt);
    await h.answer(true, original.deadlineAt!);
    expect((await h.session()).answers).toHaveLength(1);
    expect((await h.state())?.exams).toEqual([expect.objectContaining({ score: 1, total: 33, timedOut: true })]);
    expect(await h.engine.maintenance(NOW + 61 * MINUTE)).toEqual([]);
    expect((await h.state())?.exams).toHaveLength(1);
  });

  it('finishes an unattended exam once through maintenance and includes unanswered questions in review', async () => {
    const h = harness();
    await h.send({ action: 'start:exam' });
    const session = await h.session();
    h.restart();
    const expired = await h.engine.maintenance(NOW + 60 * MINUTE);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.id).toBe(`timeout_${session.id}`);
    expect(await h.engine.maintenance(NOW + 61 * MINUTE)).toEqual(expired);
    await h.acknowledge(expired);
    expect(await h.engine.maintenance(NOW + 62 * MINUTE)).toEqual([]);
    expect((await h.state())?.exams).toHaveLength(1);
    const review = await h.send({ action: `mistakes:${session.id}:0`, now: NOW + 62 * MINUTE });
    expect(review?.text).toContain('Разбор 1/33');
    expect(review?.text).toContain('Ответ не дан.');
  });

  it('does not offer a shortened exam when the bank has fewer than 33 questions', async () => {
    const course = loadCourse();
    course.questions = course.questions.slice(0, 32);
    const h = harness(course);
    expect((await h.send({ action: 'start:exam' }))?.text).toContain('не менее 33');
    expect((await h.state())?.session).toBeNull();
  });
});

describe('vocabulary scheduling', () => {
  it('advances a word only when it is first seen or due; an early lesson replay preserves its interval', async () => {
    const h = harness();
    await h.send({ action: 'lesson:l001' });
    const first = (await h.session()).steps[0]!;
    if (first.kind !== 'word') throw new Error('Expected word');
    const id = first.word.id;
    await h.answer();
    expect((await h.state())?.cards[id]).toEqual({ level: 1, dueAt: NOW + DAY, seen: 1, mistakes: 0 });
    await h.send({ action: 'lesson:l001', now: NOW + MINUTE });
    await h.answer(true, NOW + MINUTE);
    expect((await h.state())?.cards[id]).toEqual({ level: 1, dueAt: NOW + DAY, seen: 2, mistakes: 0 });
    await h.send({ action: 'lesson:l001', now: NOW + DAY });
    await h.answer(true, NOW + DAY);
    expect((await h.state())?.cards[id]).toEqual({ level: 2, dueAt: NOW + 4 * DAY, seen: 3, mistakes: 0 });
  });

  it.each([false, true])('schedules ten-minute relearning for a mistake or hint (hint=%s)', async hinted => {
    const h = harness();
    await h.send({ action: 'lesson:l001' });
    const session = await h.session();
    const step = session.steps[0]!;
    if (step.kind !== 'word') throw new Error('Expected word');
    if (hinted) await h.send({ action: `hint:${session.id}:0` });
    await h.answer(hinted);
    expect((await h.state())?.cards[step.word.id]).toEqual({ level: 0, dueAt: NOW + 10 * MINUTE, seen: 1, mistakes: hinted ? 0 : 1 });
    const before = await h.send({ action: 'menu:review', now: NOW + 9 * MINUTE });
    expect(before?.text).toContain('повторений нет');
    await h.send({ action: 'menu:review', now: NOW + 10 * MINUTE });
    const review = await h.session();
    expect(review.steps).toHaveLength(1);
    expect(review.steps[0]).toMatchObject({ kind: 'word', word: { id: step.word.id } });
  });
});

describe('access, isolation and delivery leases', () => {
  it('silently rejects unknown users, groups, invalid IDs and cross-user callback reuse', async () => {
    const h = harness();
    for (const input of [
      { userId: 3, chatId: 3 }, { userId: 1, chatId: -100 }, { userId: 1, chatId: 2 },
      { userId: -1, chatId: -1 }, { userId: 1.5, chatId: 1.5 },
    ]) expect(await h.engine.handle(h.event({ ...input, text: '/start' }))).toEqual([]);
    expect(await h.store.list('u_')).toEqual([]);
    await h.send({ action: 'menu:practice' });
    await h.send({ action: 'menu:practice', userId: 2, chatId: 2 });
    const first = await h.session(1);
    const second = await h.session(2);
    await h.send({ userId: 2, chatId: 2, action: `answer:${first.id}:0:0` });
    expect((await h.state(2))?.attempts).toBe(0);
    expect(await h.session(1)).toEqual(first);
    expect(await h.session(2)).toEqual(second);
    await h.answer(true, NOW, 1);
    expect((await h.state(1))?.attempts).toBe(1);
    expect((await h.state(2))?.attempts).toBe(0);
  });

  it('denies revoked users both new commands and pending notification delivery', async () => {
    const h = harness();
    const pending = await h.engine.handle(h.event({ text: '/remind 19:00 Asia/Yerevan' }));
    expect(pending).toHaveLength(1);
    h.restart([2]);
    expect(await h.engine.handle(h.event({ text: '/start' }))).toEqual([]);
    expect(await h.engine.maintenance(Date.parse('2026-10-28T15:00:00Z'))).toEqual([]);
    expect(await h.engine.claim(1, pending[0]!.id)).toBe(false);
  });

  it('permits configured admins without exposing admin details to ordinary users', async () => {
    const h = harness();
    h.restart([1], [2]);
    expect((await h.send({ text: '/admin' }))?.text).not.toContain('ALLOWED_USER_IDS');
    expect((await h.send({ userId: 2, chatId: 2, text: '/admin' }))?.text).toContain('Доступ разрешён 2');
  });

  it('leases a delivery to one sender, allows retry after release/expiry, and removes an acknowledged delivery', async () => {
    const h = harness();
    let now = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const pending = await h.engine.handle(h.event({ text: '/start' }));
    const id = pending[0]!.id;
    expect(await h.engine.claim(1, id)).toBe(true);
    expect(await h.engine.claim(1, id)).toBe(false);
    await h.engine.release(1, id);
    expect(await h.engine.claim(1, id)).toBe(true);
    now += 30_000;
    expect(await h.engine.claim(1, id)).toBe(true);
    await h.engine.acknowledge(1, id);
    expect(await h.engine.claim(1, id)).toBe(false);
  });

  it('resets only the requesting user after explicit confirmation', async () => {
    const h = harness();
    for (const userId of [1, 2]) {
      await h.send({ userId, chatId: userId, action: 'menu:practice' });
      await h.answer(true, NOW, userId);
    }
    const second = await h.state(2);
    await h.send({ text: '/reset' });
    expect((await h.state())?.attempts).toBe(1);
    await h.send({ action: 'reset:confirm' });
    expect(await h.state()).toMatchObject({ attempts: 0, correct: 0, session: null, cards: {}, exams: [], reminders: { enabled: false } });
    expect(await h.state(2)).toEqual(second);
  });
});

describe('public access', () => {
  it('registers an unlisted private-chat user, teaches a question and allows delivery claims with an empty allowlist', async () => {
    const h = harness(loadCourse(), 'public');
    h.restart([], []);
    const userId = 701;
    const home = await h.send({ userId, chatId: userId, text: '/start' });
    expect(home?.text).toContain('Армянский');
    await h.send({ userId, chatId: userId, action: 'menu:practice' });
    await h.answer(true, NOW, userId);
    expect(await h.state(userId)).toMatchObject({ userId, chatId: userId, attempts: 1, correct: 1 });
    const pending = await h.engine.handle(h.event({ userId, chatId: userId, text: '/progress' }));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ userId, chatId: userId });
    expect(await h.engine.claim(userId, pending[0]!.id)).toBe(true);
    expect(await h.engine.claim(userId + 1, pending[0]!.id)).toBe(false);
  });

  it('still rejects groups, cross-user chat IDs and invalid user IDs', async () => {
    const h = harness(loadCourse(), 'public');
    h.restart([], []);
    for (const input of [
      { userId: 701, chatId: -100 }, { userId: 701, chatId: 702 },
      { userId: 0, chatId: 0 }, { userId: -1, chatId: -1 },
      { userId: 1.5, chatId: 1.5 }, { userId: Number.MAX_SAFE_INTEGER + 1, chatId: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(await h.engine.handle(h.event({ ...input, text: '/start' }))).toEqual([]);
      if (input.userId <= 0 || !Number.isSafeInteger(input.userId)) expect(await h.engine.claim(input.userId, 'missing')).toBe(false);
    }
    expect(await h.store.list('u_')).toEqual([]);
  });

  it('keeps public users isolated and reserves administrative information for explicit admins', async () => {
    const h = harness(loadCourse(), 'public');
    h.restart([], [999]);
    for (const userId of [701, 702]) await h.send({ userId, chatId: userId, action: 'menu:practice' });
    const first = await h.session(701);
    const second = await h.session(702);
    await h.send({ userId: 702, chatId: 702, action: `answer:${first.id}:0:0` });
    expect(await h.session(701)).toEqual(first);
    expect(await h.session(702)).toEqual(second);
    await h.answer(true, NOW, 701);
    expect((await h.state(701))?.attempts).toBe(1);
    expect((await h.state(702))?.attempts).toBe(0);
    const denied = await h.send({ userId: 701, chatId: 701, text: '/admin' });
    expect(denied?.text).not.toContain('ADMIN_USER_IDS');
    const admin = await h.send({ userId: 999, chatId: 999, text: '/admin' });
    expect(admin?.text).toContain('Доступ открыт всем');
    expect(admin?.text).toContain('ADMIN_USER_IDS');
    for (const id of ['701', '702', '999']) expect(admin?.text).not.toContain(id);
  });

  it('stops access and scheduled deliveries when a formerly public user is excluded by private mode', async () => {
    const h = harness(loadCourse(), 'public');
    h.restart([], []);
    await h.send({ userId: 701, chatId: 701, text: '/remind 19:00 Asia/Yerevan' });
    h.restart([1], [], 'private');
    expect(await h.engine.handle(h.event({ userId: 701, chatId: 701, text: '/start' }))).toEqual([]);
    expect(await h.engine.maintenance(Date.parse('2026-10-28T15:00:00Z'))).toEqual([]);
  });

  it('discovers reminders on pages after the first 100 registered users and avoids transactions for idle users', async () => {
    const h = harness(loadCourse(), 'public');
    h.restart([], []);
    for (let userId = 1000; userId < 1105; userId++) {
      await h.send({ userId, chatId: userId, text: '/start' });
    }
    for (const userId of [1000, 1104]) {
      await h.send({ userId, chatId: userId, text: '/remind 19:00 Asia/Yerevan' });
    }
    const pages = vi.spyOn(h.store, 'listPage');
    const transactions = vi.spyOn(h.store, 'update');
    const at = Date.parse('2026-10-28T15:00:00Z');
    const pending = await h.engine.maintenance(at);
    expect(pages).toHaveBeenCalledTimes(2);
    expect(pages).toHaveBeenNthCalledWith(1, 'u_', { afterKey: undefined, limit: 100 });
    expect(pages).toHaveBeenNthCalledWith(2, 'u_', { afterKey: 'u_1099', limit: 100 });
    expect(transactions).toHaveBeenCalledTimes(2);
    expect(pending.map(item => item.userId)).toEqual([1000, 1104]);
    expect(pending.every(item => item.chatId === item.userId && item.id === 'reminder_2026-10-28')).toBe(true);
    await h.acknowledge(pending);
    transactions.mockClear();
    expect(await h.engine.maintenance(at + 5 * MINUTE)).toEqual([]);
    expect(transactions).not.toHaveBeenCalled();
  });

  it('expires public exams and retries pending messages independently of the allowlist', async () => {
    const h = harness(loadCourse(), 'public');
    h.restart([], []);
    await h.send({ userId: 701, chatId: 701, action: 'start:exam' });
    const session = await h.session(701);
    const message = await h.engine.handle(h.event({ userId: 702, chatId: 702, text: '/start' }));
    h.restart([], []);
    const pending = await h.engine.maintenance(NOW + 60 * MINUTE);
    expect(pending).toHaveLength(2);
    expect(pending.find(item => item.userId === 701)?.id).toBe(`timeout_${session.id}`);
    expect(pending.find(item => item.userId === 702)).toEqual(message[0]);
    expect((await h.state(701))?.exams).toEqual([expect.objectContaining({ timedOut: true, total: 33 })]);
  });

  it('ignores malformed and mismatched public records without mixing user deliveries', async () => {
    const h = harness(loadCourse(), 'public');
    h.restart([], []);
    await h.send({ userId: 700, chatId: 700, text: '/remind 19:00 Asia/Yerevan' });
    const template = (await h.state(700))!;
    const records: Array<[string, unknown]> = [
      ['u_bad', { schema: 1 }],
      ['u_000700', template],
      ['u_701', template],
      ['u_0', { ...template, userId: 0, chatId: 0 }],
      ['u_702', { ...template, userId: 702, chatId: 703 }],
      ['u_704', { ...template, userId: 704, chatId: 704, reminders: { ...template.reminders, timeZone: 'Invalid/Zone' } }],
      ['u_705', { ...template, userId: 705, chatId: 705, session: {} }],
      ['u_706', { ...template, userId: 706, chatId: 706, outbox: [{ id: 'wrong', userId: 700, chatId: 700, view: { text: 'wrong user' } }] }],
    ];
    for (const [key, state] of records) await h.store.update(key, () => ({ state, result: undefined }));
    const pending = await h.engine.maintenance(Date.parse('2026-10-28T15:00:00Z'));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ userId: 700, chatId: 700, id: 'reminder_2026-10-28' });
    expect(await h.engine.handle(h.event({ userId: 701, chatId: 701, text: '/start' }))).toEqual([]);
    expect(await h.engine.claim(701, pending[0]!.id)).toBe(false);
  });

  it('rechecks a public user atomically when reminder preferences change after the page was read', async () => {
    const h = harness(loadCourse(), 'public');
    h.restart([], []);
    await h.send({ userId: 701, chatId: 701, text: '/remind 19:00 Asia/Yerevan' });
    const listPage = h.store.listPage.bind(h.store);
    vi.spyOn(h.store, 'listPage').mockImplementationOnce(async (prefix, options) => {
      const page = await listPage(prefix, options);
      await h.store.update('u_701', raw => {
        const user = raw as UserState;
        user.reminders.enabled = false;
        return { state: user, result: undefined };
      });
      return page;
    });
    expect(await h.engine.maintenance(Date.parse('2026-10-28T15:00:00Z'))).toEqual([]);
    expect((await h.state(701))?.reminders.lastSentDate).toBeNull();
  });
});

describe('opt-in reminders', () => {
  it('uses the selected time zone and sends at most once per local date across restarts and setting changes', async () => {
    const h = harness();
    await h.send({ text: '/remind 19:00 Asia/Yerevan' });
    const at = Date.parse('2026-10-28T15:00:00Z');
    expect(await h.engine.maintenance(at - MINUTE)).toEqual([]);
    const first = await h.engine.maintenance(at);
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe('reminder_2026-10-28');
    await h.acknowledge(first);
    h.restart();
    expect(await h.engine.maintenance(at + 5 * MINUTE)).toEqual([]);
    await h.send({ text: '/remind 19:05 Asia/Yerevan', now: at + 5 * MINUTE });
    expect(await h.engine.maintenance(at + 5 * MINUTE)).toEqual([]);
    const nextDay = await h.engine.maintenance(at + DAY + 5 * MINUTE);
    expect(nextDay).toHaveLength(1);
    expect(nextDay[0]?.id).toBe('reminder_2026-10-29');
  });

  it('does not backfill a missed slot and respects a different UTC offset', async () => {
    const h = harness();
    await h.send({ text: '/remind 19:00 Asia/Qyzylorda' });
    const at = Date.parse('2026-10-28T14:00:00Z');
    expect(await h.engine.maintenance(at + 10 * MINUTE)).toEqual([]);
    expect(await h.engine.maintenance(at + 3 * 60 * MINUTE)).toEqual([]);
    expect((await h.state())?.reminders.lastSentDate).toBeNull();
    const next = await h.engine.maintenance(at + DAY + 5 * MINUTE);
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe('reminder_2026-10-29');
  });

  it('delivers a 23:59 reminder after midnight under the previous scheduled date and does not duplicate it', async () => {
    const h = harness();
    await h.send({ text: '/remind 23:59 Asia/Yerevan' });
    // In Yerevan this is October 29 at 00:02, three minutes after the October 28 slot.
    const afterMidnight = Date.parse('2026-10-28T20:02:00Z');
    const first = await h.engine.maintenance(afterMidnight);
    expect(first.map(item => item.id)).toEqual(['reminder_2026-10-28']);
    expect((await h.state())?.reminders.lastSentDate).toBe('2026-10-28');
    expect((await h.state())?.outbox[0]).toMatchObject({
      expiresAt: Date.parse('2026-10-28T20:09:00Z'),
    });
    await h.acknowledge(first);
    h.restart();
    expect(await h.engine.maintenance(afterMidnight + 5 * MINUTE)).toEqual([]);
    const nextDay = await h.engine.maintenance(afterMidnight + DAY);
    expect(nextDay.map(item => item.id)).toEqual(['reminder_2026-10-29']);
    expect((await h.state())?.reminders.lastSentDate).toBe('2026-10-29');
  });

  it('does not backfill the previous date after the 23:59 reminder grace window closes at 00:09', async () => {
    const h = harness();
    await h.send({ text: '/remind 23:59 Asia/Yerevan' });
    const expiry = Date.parse('2026-10-28T20:09:00Z');
    expect(await h.engine.maintenance(expiry)).toEqual([]);
    expect((await h.state())?.reminders.lastSentDate).toBeNull();
    const nextSlot = await h.engine.maintenance(Date.parse('2026-10-29T19:59:00Z'));
    expect(nextSlot.map(item => item.id)).toEqual(['reminder_2026-10-29']);
  });

  it('removes an already queued reminder when switched off without discarding ordinary pending messages', async () => {
    const h = harness();
    const at = Date.parse('2026-10-28T15:00:00Z');
    await h.send({ text: '/remind 19:00 Asia/Yerevan' });
    const ordinaryEvent = h.event({ text: '/progress', now: at });
    const ordinary = await h.engine.handle(ordinaryEvent);
    expect(ordinary).toHaveLength(1);
    const queued = await h.engine.maintenance(at);
    expect(queued.map(item => item.id)).toContain('reminder_2026-10-28');
    const disabled = await h.engine.handle(h.event({ action: 'settings:off', now: at + MINUTE }));
    expect(disabled.map(item => item.id)).toContain(ordinary[0]!.id);
    expect(disabled.some(item => item.id.startsWith('reminder_'))).toBe(false);
    expect((await h.state())?.outbox.some(item => item.id.startsWith('reminder_'))).toBe(false);
    expect((await h.state())?.reminders.enabled).toBe(false);
    await h.acknowledge(disabled);
    await h.send({ action: 'settings:on', now: at + 2 * MINUTE });
    expect(await h.engine.maintenance(at + 2 * MINUTE)).toEqual([]);
  });

  it.each(['maintenance', 'handle', 'duplicate handle'] as const)('prunes expired queued reminders through %s at the end of the local slot', async trigger => {
    const h = harness();
    const at = Date.parse('2026-10-28T15:00:00Z');
    await h.send({ text: '/remind 19:00 Asia/Yerevan' });
    const ordinaryEvent = h.event({ text: '/progress', now: at });
    const ordinary = await h.engine.handle(ordinaryEvent);
    const queued = await h.engine.maintenance(at + 5 * MINUTE + 30_123);
    expect(queued.map(item => item.id)).toContain('reminder_2026-10-28');
    expect((await h.state())?.outbox.find(item => item.id === 'reminder_2026-10-28'))
      .toMatchObject({ expiresAt: at + 10 * MINUTE });
    expect((await h.engine.maintenance(at + 10 * MINUTE - 1)).map(item => item.id))
      .toContain('reminder_2026-10-28');
    h.restart();
    const expiry = at + 10 * MINUTE;
    const result = trigger === 'maintenance'
      ? await h.engine.maintenance(expiry)
      : await h.engine.handle(trigger === 'duplicate handle'
        ? { ...ordinaryEvent, now: expiry }
        : h.event({ text: '/start', now: expiry }));
    expect(result.some(item => item.id.startsWith('reminder_'))).toBe(false);
    expect(result.map(item => item.id)).toContain(ordinary[0]!.id);
    expect((await h.state())?.outbox.some(item => item.id.startsWith('reminder_'))).toBe(false);
    await h.acknowledge(result);
    expect(await h.engine.maintenance(expiry + MINUTE)).toEqual([]);
    const tomorrow = await h.engine.maintenance(at + DAY);
    expect(tomorrow.map(item => item.id)).toEqual(['reminder_2026-10-29']);
  });

  it('rejects a reminder claimed at expiry even when it was fetched during its delivery window', async () => {
    const h = harness();
    const at = Date.parse('2026-10-28T15:00:00Z');
    let now = at + 5 * MINUTE;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await h.send({ text: '/remind 19:00 Asia/Yerevan' });
    const queued = await h.engine.maintenance(now);
    const id = queued[0]!.id;
    expect(await h.engine.claim(1, id)).toBe(true);
    await h.engine.release(1, id);
    now = at + 10 * MINUTE;
    expect(await h.engine.claim(1, id)).toBe(false);
    expect((await h.state())?.outbox).toEqual([]);
  });

  it('is off by default, can be disabled, and suppresses deliveries after the user blocks the bot', async () => {
    const h = harness();
    await h.send({ text: '/start' });
    const at = Date.parse('2026-10-28T14:00:00Z');
    expect(await h.engine.maintenance(at)).toEqual([]);
    await h.send({ text: '/remind 19:00 Asia/Qyzylorda' });
    await h.send({ action: 'settings:off' });
    expect(await h.engine.maintenance(at)).toEqual([]);
    await h.send({ action: 'settings:on' });
    await h.engine.suppressNotifications(1);
    expect(await h.engine.maintenance(at)).toEqual([]);
    expect(await h.state()).toMatchObject({ blocked: true, reminders: { enabled: false }, outbox: [] });
    await h.send({ text: '/start' });
    expect(await h.state()).toMatchObject({ blocked: false, reminders: { enabled: false } });
  });

  it.each(['/remind 24:00 Asia/Yerevan', '/remind 19:60 Asia/Yerevan', '/remind 19:00 Not/A_Zone'])('rejects malformed reminder settings: %s', async text => {
    const h = harness();
    expect((await h.send({ text }))?.text).toContain('Формат:');
    expect((await h.state())?.reminders).toEqual({ enabled: false, time: '19:00', timeZone: 'Asia/Qyzylorda', lastSentDate: null });
  });
});
