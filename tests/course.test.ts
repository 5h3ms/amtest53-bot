import { describe, expect, it } from 'vitest';
import { loadCourse, validateCourse } from '../src/course.js';

describe('published starter course', () => {
  it('loads the actual bank with source attribution and enough material for the pilot', () => {
    const course = loadCourse();
    expect(course.version).toContain('authored_training');
    expect(course.questions.length).toBeGreaterThanOrEqual(40);
    expect(course.vocabulary.length).toBeGreaterThanOrEqual(60);
    expect(course.lessons.length).toBeGreaterThanOrEqual(10);
    expect(course.noticeRu).toMatch(/авторск/i);
    expect(new Set(course.questions.map(question => question.promptHy)).size).toBe(course.questions.length);
    for (const question of course.questions) {
      expect(question.source.url).toBe('https://arlis.am/hy/acts/143723/latest');
      expect(question.source.article).toMatch(/\d/);
      expect(question.source.checkedOn).toBe(course.checkedOn);
      expect(question.options[question.correctIndex]).toBeDefined();
      expect(question.promptHy).toMatch(/[\u0530-\u058f]/);
      expect(question.promptRu).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('covers every starter question and word through its lessons', () => {
    const course = loadCourse();
    expect(new Set(course.lessons.flatMap(lesson => lesson.questionIds))).toEqual(new Set(course.questions.map(question => question.id)));
    expect(new Set(course.lessons.flatMap(lesson => lesson.vocabularyIds))).toEqual(new Set(course.vocabulary.map(word => word.id)));
  });

  it('accepts vocabulary-only lessons and preserves the supported vocabulary categories', () => {
    const course = loadCourse();
    course.lessons[0]!.questionIds = [];
    course.vocabulary[0]!.category = 'nouns';
    course.vocabulary[1]!.category = 'verbs';
    course.vocabulary[2]!.category = 'other';
    const validated = validateCourse(course);
    expect(validated.lessons[0]!.questionIds).toEqual([]);
    expect(validated.vocabulary.slice(0, 3).map(word => word.category)).toEqual(['nouns', 'verbs', 'other']);
  });

  it.each(['questions', 'vocabulary', 'lessons'] as const)('rejects duplicate IDs in %s', section => {
    const course = loadCourse();
    course[section][1]!.id = course[section][0]!.id;
    expect(() => validateCourse(course)).toThrow(/Duplicate IDs/);
  });

  it('rejects repeated answers and wrong answer indices', () => {
    const repeated = loadCourse();
    repeated.questions[0]!.options[1]!.hy = repeated.questions[0]!.options[0]!.hy;
    expect(() => validateCourse(repeated)).toThrow(/Repeated options/);
    const invalidIndex = loadCourse();
    invalidIndex.questions[0]!.correctIndex = 3;
    expect(() => validateCourse(invalidIndex)).toThrow();
    const invalidCount = loadCourse();
    invalidCount.questions[0]!.options.pop();
    expect(() => validateCourse(invalidCount)).toThrow();
  });

  it('rejects unknown question/vocabulary references and duplicate lesson references', () => {
    const unknownWord = loadCourse();
    unknownWord.questions[0]!.vocabularyIds.push('v999');
    expect(() => validateCourse(unknownWord)).toThrow(/Unknown vocabulary/);
    const unknownQuestion = loadCourse();
    unknownQuestion.lessons[0]!.questionIds.push('q999');
    expect(() => validateCourse(unknownQuestion)).toThrow(/Unknown reference/);
    const unknownLessonWord = loadCourse();
    unknownLessonWord.lessons[0]!.vocabularyIds.push('v999');
    expect(() => validateCourse(unknownLessonWord)).toThrow(/Unknown reference/);
    const duplicate = loadCourse();
    duplicate.lessons[0]!.questionIds.push(duplicate.lessons[0]!.questionIds[0]!);
    expect(() => validateCourse(duplicate)).toThrow(/Repeated reference/);
  });

  it('requires an HTTPS source, a real date and nonblank educational text', () => {
    const insecure = loadCourse();
    insecure.questions[0]!.source.url = 'http://example.com';
    expect(() => validateCourse(insecure)).toThrow();
    const date = loadCourse();
    date.questions[0]!.source.checkedOn = '2026-02-30';
    expect(() => validateCourse(date)).toThrow();
    const blank = loadCourse();
    blank.questions[0]!.explanationRu = '   ';
    expect(() => validateCourse(blank)).toThrow();
  });

  it('rejects vocabulary that cannot produce three distinct translation choices', () => {
    const course = loadCourse();
    course.vocabulary.forEach((word, index) => { word.ru = index % 2 === 0 ? 'значение один' : 'значение два'; });
    expect(() => validateCourse(course)).toThrow();
  });
});
