import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateCourse, type Course, type Vocabulary } from './course.js';

const categories = ['nouns', 'verbs', 'other'] as const;
export type VocabularyCategory = typeof categories[number];
export interface VocabularyImportRecord {
  hy: string;
  ru: string;
  category: VocabularyCategory;
  source: { workbook: 'nouns' | 'verbs'; sheet: string; row: number };
}
export interface VocabularyImportStats {
  inputRecords: number;
  importedHeadwords: number;
  addedVocabulary: number;
  updatedVocabulary: number;
  generatedLessons: number;
  totalVocabulary: number;
}

const normalize = (text: string): string => text.normalize('NFC').trim().replace(/\s+/gu, ' ');
const matchHeadword = (text: string): string => normalize(text).toLocaleLowerCase('hy-AM');
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const text = z.string().min(1).max(1000).refine(value => !controls.test(value)).transform(normalize)
  .refine(value => value.length > 0);
const recordsSchema = z.array(z.object({
  hy: text.refine(value => /[\u0531-\u0556\u0561-\u0587]/u.test(value)),
  ru: text.refine(value => /[А-Яа-яЁё]/u.test(value)),
  category: z.enum(categories),
  source: z.object({
    workbook: z.enum(['nouns', 'verbs']),
    sheet: z.string().min(1).max(100).refine(value => !controls.test(value))
      .refine(value => value.trim().length > 0),
    row: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict()).min(1).max(100_000);
const generatedLessonId = /^lex_(nouns|verbs|other)_[a-f0-9]{12}$/;
const labels: Record<VocabularyCategory, string> = {
  nouns: 'Существительные', verbs: 'Глаголы', other: 'Другие слова',
};
const digest = (value: string, length: number): string => createHash('sha256').update(value).digest('hex').slice(0, length);

function mergeMeanings(previous: string, incoming: string): string {
  const seen = new Set<string>();
  const meanings: string[] = [];
  for (const item of [...previous.split(';'), ...incoming.split(';')]) {
    const meaning = normalize(item);
    const match = meaning.toLocaleLowerCase('ru-RU');
    if (meaning && !seen.has(match)) {
      seen.add(match);
      meanings.push(meaning);
    }
  }
  const merged = meanings.join('; ');
  if (merged.length > 1000) throw new Error('Merged vocabulary translation exceeds 1000 characters.');
  return merged;
}

/** All sheet content is treated as text. The supplied course and records are never mutated. */
export function importVocabulary(
  inputCourse: Course,
  inputRecords: unknown,
  options: { version?: string } = {},
): { course: Course; stats: VocabularyImportStats } {
  const parsed = recordsSchema.safeParse(inputRecords);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const row = typeof issue?.path[0] === 'number' ? ` record ${issue.path[0] + 1}` : ' records';
    const field = issue?.path.slice(1).filter(part => typeof part === 'string').join('.');
    throw new Error(`Invalid vocabulary import${row}${field ? ` (${field})` : ''}. Check field types, lengths and language markers.`);
  }
  const course = validateCourse(structuredClone(inputCourse));
  if (options.version !== undefined) {
    if (typeof options.version !== 'string' || !options.version.trim() || options.version.length > 1000 || controls.test(options.version)) {
      throw new Error('Invalid vocabulary import version.');
    }
    course.version = options.version.trim();
  }

  const byHeadword = new Map<string, Vocabulary>();
  const ids = new Set(course.vocabulary.map(word => word.id));
  const originalIds = new Set(ids);
  for (const word of course.vocabulary) {
    const headword = matchHeadword(word.hy);
    if (byHeadword.has(headword)) throw new Error('The existing course contains duplicate Armenian headwords.');
    byHeadword.set(headword, word);
  }
  let addedVocabulary = 0;
  const updatedIds = new Set<string>();
  const importedHeadwords = new Set<string>();
  for (const record of parsed.data) {
    const headword = matchHeadword(record.hy);
    importedHeadwords.add(headword);
    let word = byHeadword.get(headword);
    if (!word) {
      const id = `lex_${digest(headword, 14)}`;
      if (ids.has(id)) throw new Error('Generated vocabulary ID collides with an existing ID.');
      word = { id, hy: record.hy, ru: mergeMeanings('', record.ru), category: record.category, sources: [] };
      course.vocabulary.push(word);
      byHeadword.set(headword, word);
      ids.add(id);
      addedVocabulary += 1;
    }
    const before = JSON.stringify(word);
    word.ru = mergeMeanings(word.ru, record.ru);
    word.category ??= record.category;
    const source = record.source;
    word.sources ??= [];
    if (!word.sources.some(existing => existing.workbook === source.workbook &&
      existing.sheet === source.sheet && existing.row === source.row)) {
      word.sources.push({ ...source });
    }
    if (originalIds.has(word.id) && before !== JSON.stringify(word)) updatedIds.add(word.id);
  }

  // Generated lesson IDs mark only importer-owned vocabulary lessons; authored lessons stay intact.
  course.lessons = course.lessons.filter(lesson => !(generatedLessonId.test(lesson.id) && lesson.questionIds.length === 0));
  const lessonIds = new Set(course.lessons.map(lesson => lesson.id));
  let generatedLessons = 0;
  for (const category of categories) {
    const words = course.vocabulary.filter(word => word.category === category)
      .sort((left, right) => {
        const a = matchHeadword(left.hy), b = matchHeadword(right.hy);
        return a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    for (let offset = 0; offset < words.length; offset += 10) {
      const vocabularyIds = words.slice(offset, offset + 10).map(word => word.id);
      const id = `lex_${category}_${digest(vocabularyIds.join('\n'), 12)}`;
      if (lessonIds.has(id)) throw new Error('Generated vocabulary lesson ID collides with an existing ID.');
      lessonIds.add(id);
      course.lessons.push({
        id, titleRu: `${labels[category]} · ${offset / 10 + 1}`,
        introRu: 'Прочитайте армянское слово и выберите его русский перевод. Повторите слова, в которых ошиблись.',
        vocabularyIds, questionIds: [],
      });
      generatedLessons += 1;
    }
  }
  return {
    course: validateCourse(course),
    stats: { inputRecords: parsed.data.length, importedHeadwords: importedHeadwords.size, addedVocabulary,
      updatedVocabulary: updatedIds.size, generatedLessons, totalVocabulary: course.vocabulary.length },
  };
}
