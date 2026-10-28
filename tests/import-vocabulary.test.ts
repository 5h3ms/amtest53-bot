import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateCourse, type Course } from '../src/course.js';
import { importVocabulary, type VocabularyImportRecord } from '../src/import-vocabulary.js';

function baseCourse(): Course {
  return validateCourse({
    version: 'authored.v1', title: 'Учебный курс', noticeRu: 'Учебные материалы', checkedOn: '2026-10-28',
    questions: [{
      id: 'q001', topic: 'Государство', promptHy: 'Հայաստան', promptRu: 'Армения',
      options: [{ hy: 'Հայաստան', ru: 'Армения' }, { hy: 'պետություն', ru: 'государство' }, { hy: 'քաղաքացի', ru: 'гражданин' }, { hy: 'ժողովուրդ', ru: 'народ' }],
      correctIndex: 0, explanationRu: 'Объяснение',
      source: { url: 'https://example.org/constitution', article: '1', checkedOn: '2026-10-28' },
      vocabularyIds: ['v001'],
    }],
    vocabulary: [
      { id: 'v001', hy: 'Հայաստան', ru: 'Армения', exampleHy: 'Հայաստան', exampleRu: 'Армения' },
      { id: 'v002', hy: 'պետություն', ru: 'государство' },
      { id: 'v003', hy: 'քաղաքացի', ru: 'гражданин' },
      { id: 'v004', hy: 'ժողովուրդ', ru: 'народ' },
    ],
    lessons: Array.from({ length: 10 }, (_, index) => ({
      id: `l${String(index + 1).padStart(3, '0')}`, titleRu: `Урок ${index + 1}`, introRu: 'Инструкция',
      vocabularyIds: ['v001', 'v002', 'v003', 'v004'], questionIds: ['q001'],
    })),
  });
}

function record(overrides: Partial<VocabularyImportRecord> = {}): VocabularyImportRecord {
  return { hy: 'գիրք', ru: 'кнИга', category: 'nouns', source: { workbook: 'nouns', sheet: 'Слова', row: 2 }, ...overrides };
}

describe('vocabulary importer', () => {
  it('merges authored headwords, distinct meanings and provenance without losing references or stress capitals', () => {
    const original = baseCourse();
    const records = [
      record({ hy: '  պետություն\n', ru: 'Государство; странА' }),
      record({ hy: 'պետություն', ru: ' странА ; держава ', source: { workbook: 'nouns', sheet: 'Слова', row: 3 } }),
      record({ hy: 'պետություն', ru: 'ДЕРЖАВА', category: 'other' }),
      record(),
    ];
    const { course, stats } = importVocabulary(original, records);
    expect(course.vocabulary).toHaveLength(5);
    expect(course.vocabulary.find(word => word.id === 'v002')).toEqual({
      id: 'v002', hy: 'պետություն', ru: 'государство; странА; держава', category: 'nouns',
      sources: [{ workbook: 'nouns', sheet: 'Слова', row: 2 }, { workbook: 'nouns', sheet: 'Слова', row: 3 }],
    });
    expect(course.vocabulary.find(word => word.hy === 'գիրք')?.ru).toBe('кнИга');
    expect(course.questions).toEqual(original.questions);
    expect(course.lessons.slice(0, 10)).toEqual(original.lessons);
    expect(course.vocabulary[0]).toEqual(original.vocabulary[0]);
    expect(stats).toEqual({ inputRecords: 4, importedHeadwords: 2, addedVocabulary: 1,
      updatedVocabulary: 1, generatedLessons: 1, totalVocabulary: 5 });
  });

  it('normalizes whitespace and NFC for matching, and derives IDs from normalized Armenian text', () => {
    const records = [record({ hy: ' տերմին  e\u0301 ' }), record({ hy: 'տերմին é', ru: 'КНИГА' })];
    const { course } = importVocabulary(baseCourse(), records);
    const added = course.vocabulary.filter(word => word.id.startsWith('lex_'));
    const suffix = createHash('sha256').update('տերմին é').digest('hex').slice(0, 14);
    expect(added).toHaveLength(1);
    expect(added[0]?.id).toBe(`lex_${suffix}`);
    expect(added[0]?.hy).toBe('տերմին é');
    expect(added[0]?.ru).toBe('кнИга');
    expect(added[0]?.sources).toHaveLength(1);
  });

  it('matches Armenian case-insensitively while preserving the first display spelling and exact source sheets', () => {
    const records = [
      record({ hy: 'Գիրք', source: { workbook: 'nouns', sheet: 'Сущ. ', row: 2 } }),
      record({ hy: 'գիրք', source: { workbook: 'nouns', sheet: 'Сущ.', row: 2 } }),
      record({ hy: 'ԳԻՐՔ', source: { workbook: 'nouns', sheet: 'Сущ. ', row: 2 } }),
    ];
    const { course, stats } = importVocabulary(baseCourse(), records);
    const added = course.vocabulary.at(-1)!;
    expect(added.hy).toBe('Գիրք');
    expect(added.id).toBe(`lex_${createHash('sha256').update('գիրք').digest('hex').slice(0, 14)}`);
    expect(added.sources).toEqual([
      { workbook: 'nouns', sheet: 'Сущ. ', row: 2 }, { workbook: 'nouns', sheet: 'Сущ.', row: 2 },
    ]);
    expect(stats.importedHeadwords).toBe(1);
  });

  it('builds category lessons of at most ten terms with complete nonduplicated coverage', () => {
    const records = Array.from({ length: 24 }, (_, index) => record({
      hy: `բառ ${index}`, ru: `слово ${index}`, category: index < 21 ? 'nouns' : index < 23 ? 'verbs' : 'other',
      source: { workbook: index < 21 ? 'nouns' : 'verbs', sheet: 'Слова', row: index + 2 },
    }));
    const { course, stats } = importVocabulary(baseCourse(), records);
    const lessons = course.lessons.slice(10);
    expect(stats.generatedLessons).toBe(5);
    expect(lessons.map(lesson => lesson.titleRu)).toEqual([
      'Существительные · 1', 'Существительные · 2', 'Существительные · 3', 'Глаголы · 1', 'Другие слова · 1',
    ]);
    expect(lessons.map(lesson => lesson.vocabularyIds.length)).toEqual([10, 10, 1, 2, 1]);
    expect(lessons.every(lesson => lesson.questionIds.length === 0)).toBe(true);
    const covered = lessons.flatMap(lesson => lesson.vocabularyIds);
    expect(new Set(covered).size).toBe(24);
    expect([...covered].sort()).toEqual(course.vocabulary.filter(word => word.category).map(word => word.id).sort());
    const reversed = importVocabulary(baseCourse(), [...records].reverse()).course;
    expect(reversed.lessons).toEqual(course.lessons);
  });

  it('is idempotent and does not mutate either input', () => {
    const original = baseCourse();
    const records = [record(), record({ hy: 'պետություն', ru: 'госудАрство; странА' })];
    const savedCourse = structuredClone(original), savedRecords = structuredClone(records);
    const version = '2026-10-28.authored_training.user_vocab.v2';
    const first = importVocabulary(original, records, { version });
    const second = importVocabulary(first.course, records, { version });
    expect(second.course).toEqual(first.course);
    expect(second.stats.addedVocabulary).toBe(0);
    expect(second.stats.updatedVocabulary).toBe(0);
    expect(first.course.version).toBe(version);
    expect(original).toEqual(savedCourse);
    expect(records).toEqual(savedRecords);
  });

  it('retains an existing category and authored examples when another source classifies a word differently', () => {
    const original = baseCourse();
    original.vocabulary[0]!.category = 'other';
    const { course } = importVocabulary(original, [record({ hy: 'Հայաստան', ru: 'АрмЕния', category: 'nouns' })]);
    expect(course.vocabulary[0]).toMatchObject({ id: 'v001', category: 'other', ru: 'Армения', exampleRu: 'Армения' });
    expect(course.lessons.at(-1)?.titleRu).toBe('Другие слова · 1');
  });

  it.each([
    [], null, {},
    [record({ hy: '  ' })], [record({ hy: 'not Armenian' })], [record({ ru: 'English' })],
    [record({ hy: 'հ'.repeat(1001) })], [record({ ru: 'я'.repeat(1001) })],
    [record({ hy: 'գիրք\u0000' })],
    [{ ...record(), category: 'invalid' }],
    [record({ source: { workbook: 'nouns', sheet: ' ', row: 2 } })],
    [record({ source: { workbook: 'nouns', sheet: 'я'.repeat(101), row: 2 } })],
    [record({ source: { workbook: 'nouns', sheet: 'Слова', row: 0 } })],
    [record({ source: { workbook: 'nouns', sheet: 'Слова', row: 1.5 } })],
    [record({ source: { workbook: 'nouns', sheet: 'Слова', row: Number.MAX_SAFE_INTEGER + 1 } })],
    [{ ...record(), source: { workbook: 'other', sheet: 'Слова', row: 2 } }],
  ].map(records => ({ records })))('rejects invalid normalized input without mutating the course', ({ records }) => {
    const original = baseCourse(), saved = structuredClone(original);
    expect(() => importVocabulary(original, records)).toThrow('Invalid vocabulary import');
    expect(original).toEqual(saved);
  });

  it('fails before changing input when separately valid meanings overflow the display limit', () => {
    const original = baseCourse(), saved = structuredClone(original);
    const records = [record({ ru: 'а'.repeat(600) }), record({ ru: 'б'.repeat(600) })];
    expect(() => importVocabulary(original, records)).toThrow('exceeds 1000');
    expect(original).toEqual(saved);
  });

  it('keeps formula-like cell text inert', () => {
    const records = [record({ hy: '=գիրք', ru: '=кнИга; +учебник' })];
    const { course } = importVocabulary(baseCourse(), records);
    expect(course.vocabulary.at(-1)).toMatchObject({ hy: '=գիրք', ru: '=кнИга; +учебник' });
  });
});
