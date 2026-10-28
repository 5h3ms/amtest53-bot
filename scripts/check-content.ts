import { loadCourse } from '../src/course.js';
const course = loadCourse();
if (course.questions.length < 33) throw new Error('Full practice exam needs 33 distinct verified questions');
for (const question of course.questions) {
  const size = [question.promptHy, question.promptRu, ...question.options.flatMap(x => [x.hy, x.ru]),
    question.explanationRu, question.source.article, question.source.url,
    ...(question.readingHelp ?? []).flatMap(item => [item.hy, item.ru, item.noteRu])].join('\n').length;
  if (size > 3300) throw new Error(`Question ${question.id} is too long for Telegram`);
}
console.log(`Course ${course.version}: ${course.lessons.length} lessons, ${course.vocabulary.length} words, ${course.questions.length} authored training questions. References valid.`);
