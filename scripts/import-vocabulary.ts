import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateCourse } from '../src/course.js';
import { importVocabulary } from '../src/import-vocabulary.js';

async function readJson(path: string): Promise<unknown> {
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch { throw new Error('Не удалось прочитать входной файл.'); }
  try { return JSON.parse(source) as unknown; }
  catch { throw new Error('Входной файл содержит некорректный JSON.'); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    throw new Error('Использование: npm run content:import -- <normalized.json> [version]');
  }
  const coursePath = fileURLToPath(new URL('../content/course.json', import.meta.url));
  const records = await readJson(args[0]!);
  const original = await readJson(coursePath);
  let course;
  try { course = validateCourse(original); }
  catch { throw new Error('Исходный курс не прошёл проверку структуры.'); }
  const result = importVocabulary(course, records, args[1] === undefined ? {} : { version: args[1] });
  const serialized = `${JSON.stringify(result.course, null, 2)}\n`;
  const temporaryPath = `${coursePath}.import-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, coursePath);
  } catch {
    throw new Error('Не удалось сохранить курс. Проверьте доступ к каталогу content.');
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  const stats = result.stats;
  console.log(`Импорт завершён: строк ${stats.inputRecords}; уникальных слов ${stats.importedHeadwords}; добавлено карточек ${stats.addedVocabulary}; обновлено карточек ${stats.updatedVocabulary}; словарных уроков ${stats.generatedLessons}; всего карточек ${stats.totalVocabulary}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Импорт не выполнен.');
  process.exitCode = 1;
});
