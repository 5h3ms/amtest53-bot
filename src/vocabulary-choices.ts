import type { Course, Vocabulary } from './course.js';
import { vocabularyFamiliesByMeaning } from './vocabulary-families.js';

const normalize = (text: string, locale: string) => text.normalize('NFC').trim().toLocaleLowerCase(locale).replace(/\s+/g, ' ');
const meanings = (text: string, locale: string) => text.split(/[,;/]/).map(value => normalize(value, locale)).filter(Boolean);
const families = (meaning: string) => vocabularyFamiliesByMeaning.get(meaning.replace(/ё/g, 'е')) ?? [];

// Imported sheet names distinguish, for example, pronouns from adverbs inside
// the broad "other" category. For untagged starter cards, use conservative
// Russian/Armenian form hints; these rank alternatives, not dictionary definitions.
function form(word: Vocabulary): string {
  if (word.category === 'nouns' || word.category === 'verbs') return word.category;
  const translation = meanings(word.ru, 'ru-RU')[0] ?? '';
  if (/^[а-яё-]+(?:ть|ться|ти|тись|чь|чься)(?:\s|$)/u.test(translation) &&
    meanings(word.hy, 'hy-AM').some(value => /(?:ել|ալ)$/u.test(value))) return 'verbs';
  if (/^[а-яё-]+(?:ый|ий|ой|ая|яя|ое|ее|ые|ие)$/u.test(translation)) return 'adjectives';
  return word.category ?? 'nouns';
}

/** Candidates arrive shuffled, so equally relevant alternatives vary by session. */
export function selectWordDistractors(word: Vocabulary, course: Course, candidates: readonly Vocabulary[]): string[] {
  const targetForms = new Set(meanings(word.hy, 'hy-AM'));
  const usedForms = new Set(targetForms);
  const usedMeanings = new Set(meanings(word.ru, 'ru-RU'));
  const usedTranslations = new Set([normalize(word.ru, 'ru-RU')]);
  const targetFamilies = new Set([...usedMeanings].flatMap(value => [...families(value)]));
  const related = new Set(course.lessons.filter(lesson => lesson.vocabularyIds.includes(word.id)).flatMap(lesson => lesson.vocabularyIds));
  const targetForm = form(word);
  const rank = (candidate: Vocabulary): number => {
    const sameFamily = meanings(candidate.ru, 'ru-RU').some(value =>
      [...families(value)].some(family => targetFamilies.has(family)));
    let sourceCloseness = 0;
    for (const source of word.sources ?? []) {
      for (const other of candidate.sources ?? []) {
        if (source.workbook !== other.workbook || source.sheet.trim() !== other.sheet.trim()) continue;
        // Small row bands retain variation between nearby source entries.
        sourceCloseness = Math.max(sourceCloseness, 100 + Math.max(0, 40 - Math.floor(Math.abs(source.row - other.row) / 5)));
      }
    }
    const matchingForm = form(candidate) === targetForm || (sourceCloseness > 0 && word.category === candidate.category);
    return (sameFamily ? 2000 : 0) + (matchingForm ? 1000 : 0) + sourceCloseness + (related.has(candidate.id) ? 50 : 0);
  };
  const ranked = candidates.filter(candidate => candidate.id !== word.id &&
    !meanings(candidate.hy, 'hy-AM').some(value => targetForms.has(value)))
    .map(candidate => ({ candidate, rank: rank(candidate) }))
    .sort((a, b) => b.rank - a.rank);
  const choices: string[] = [];
  for (const { candidate } of ranked) {
    const armenianForms = meanings(candidate.hy, 'hy-AM');
    const translation = normalize(candidate.ru, 'ru-RU');
    const glosses = meanings(candidate.ru, 'ru-RU');
    if (!glosses.length || armenianForms.some(value => usedForms.has(value)) || usedTranslations.has(translation) || glosses.some(value => usedMeanings.has(value))) continue;
    choices.push(candidate.ru);
    armenianForms.forEach(value => usedForms.add(value));
    usedTranslations.add(translation);
    glosses.forEach(value => usedMeanings.add(value));
    if (choices.length === 3) return choices;
  }
  throw new Error('At least four non-overlapping vocabulary translations are required');
}
