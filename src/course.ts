import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);
const shortText = z.string().trim().min(1).max(1000);
const questionSchema = z.object({
  id, topic: shortText, promptHy: shortText, promptRu: shortText,
  options: z.array(z.object({ hy: shortText, ru: shortText })).length(4),
  correctIndex: z.number().int().min(0).max(3),
  explanationRu: shortText,
  readingHelp: z.array(z.object({
    hy: z.string().trim().min(1).max(160), ru: z.string().trim().min(1).max(160),
    noteRu: z.string().trim().min(1).max(240),
  })).max(3).optional(),
  source: z.object({ url: z.url().startsWith('https://'), article: shortText, checkedOn: z.iso.date() }),
  vocabularyIds: z.array(id),
});
const vocabularySchema = z.object({
  id, hy: shortText, ru: shortText, exampleHy: shortText.optional(), exampleRu: shortText.optional(),
  category: z.enum(['nouns', 'verbs', 'other']).optional(),
  sources: z.array(z.object({
    workbook: z.enum(['nouns', 'verbs']), sheet: z.string().min(1).max(100), row: z.number().int().positive(),
  })).optional(),
});
const courseSchema = z.object({
  version: shortText, title: shortText, noticeRu: shortText, checkedOn: z.iso.date(),
  questions: z.array(questionSchema).min(1),
  vocabulary: z.array(vocabularySchema).min(4),
  lessons: z.array(z.object({ id, titleRu: shortText, introRu: shortText, examTrack: z.boolean().optional(),
    vocabularyIds: z.array(id).min(1), questionIds: z.array(id) })).min(1),
});
export type Course = z.infer<typeof courseSchema>;
export type Question = Course['questions'][number];
export type Vocabulary = Course['vocabulary'][number];

export function examLessons(course: Course): Course['lessons'] {
  return course.lessons.filter(lesson => lesson.examTrack ?? lesson.questionIds.length > 0);
}

export function examVocabulary(course: Course): Vocabulary[] {
  const ids = new Set([...examLessons(course).flatMap(lesson => lesson.vocabularyIds),
    ...course.questions.flatMap(question => question.vocabularyIds)]);
  return course.vocabulary.filter(word => ids.has(word.id));
}

export function validateCourse(input: unknown): Course {
  const course = courseSchema.parse(input);
  for (const [label, items] of Object.entries({ questions: course.questions, vocabulary: course.vocabulary, lessons: course.lessons })) {
    if (new Set(items.map(x => x.id)).size !== items.length) throw new Error(`Duplicate IDs in ${label}`);
  }
  const words = new Set(course.vocabulary.map(x => x.id));
  const questions = new Set(course.questions.map(x => x.id));
  if (new Set(course.vocabulary.map(x => x.ru.toLocaleLowerCase('ru-RU'))).size < 4) {
    throw new Error('At least four distinct vocabulary translations are required');
  }
  for (const question of course.questions) {
    for (const language of ['hy', 'ru'] as const) {
      const options = question.options.map(x => x[language].normalize('NFC').trim().toLocaleLowerCase(language).replace(/\s+/g, ' '));
      if (new Set(options).size !== 4) throw new Error(`Repeated options in ${question.id}`);
    }
    if (question.vocabularyIds.some(x => !words.has(x))) throw new Error(`Unknown vocabulary in ${question.id}`);
  }
  for (const lesson of course.lessons) {
    if (lesson.vocabularyIds.some(x => !words.has(x)) || lesson.questionIds.some(x => !questions.has(x))) {
      throw new Error(`Unknown reference in ${lesson.id}`);
    }
    if (new Set(lesson.vocabularyIds).size !== lesson.vocabularyIds.length || new Set(lesson.questionIds).size !== lesson.questionIds.length) {
      throw new Error(`Repeated reference in ${lesson.id}`);
    }
  }
  return course;
}

export function loadCourse(): Course {
  const built = new URL('./content/course.json', import.meta.url);
  const file = existsSync(built) ? built : new URL('../content/course.json', import.meta.url);
  return validateCourse(JSON.parse(readFileSync(file, 'utf8')));
}
