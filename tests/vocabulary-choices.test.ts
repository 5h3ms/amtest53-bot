import { describe, expect, it } from 'vitest';
import type { Course, Vocabulary } from '../src/course.js';
import { loadCourse } from '../src/course.js';
import { selectWordDistractors } from '../src/vocabulary-choices.js';

const word = (id: string, ru: string, category?: Vocabulary['category'], sheet?: string, row = 1): Vocabulary => ({
  id, hy: `բառ_${id}`, ru, category,
  ...(sheet ? { sources: [{ workbook: 'nouns' as const, sheet, row }] } : {}),
});
const course = (vocabulary: Vocabulary[]): Course => ({
  version: 'test', title: 'Test', noticeRu: 'Test', checkedOn: '2026-10-28', questions: [], vocabulary,
  lessons: [{ id: 'lesson', titleRu: 'Test', introRu: 'Test', questionIds: [], vocabularyIds: vocabulary.map(item => item.id) }],
});

describe('plausible vocabulary alternatives', () => {
  it('can build four distinct, non-overlapping choices for every published word', () => {
    const published = loadCourse();
    expect(published.vocabulary.length).toBeGreaterThanOrEqual(824);
    for (const target of published.vocabulary) {
      const choices = selectWordDistractors(target, published, published.vocabulary);
      expect(choices, target.id).toHaveLength(3);
      expect(new Set([target.ru, ...choices]).size, target.id).toBe(4);
    }
  }, 60_000); // Exhaustive corpus validation; one user session selects at most ten words.

  it.each([
    ['столица', ['город', 'деревня', 'страна / страны', 'государство', 'родина', 'Республика Армения']],
    ['лев', ['тигр', 'лиса', 'волк', 'слон', 'медведь', 'заяц', 'обезьяна', 'мышь', 'верблюд', 'жираф', 'ежик']],
    ['варить', ['выпекать', 'жарить', 'готовить']],
    ['красный', ['черный', 'белый', 'зеленый', 'синий', 'желтый', 'голубой', 'фиолетовый', 'коричневый', 'золотистый', 'серебристый', 'розовый', 'серый']],
  ])('uses the same semantic family for the published word %s', (translation, alternatives) => {
    const published = loadCourse(), target = published.vocabulary.find(item => item.ru === translation)!;
    expect(target).toBeDefined();
    const choices = selectWordDistractors(target, published, published.vocabulary);
    expect(choices).toHaveLength(3);
    choices.forEach(choice => expect(alternatives).toContain(choice));
  });

  it.each(['власть', 'собственность', 'совесть'])('does not mistake the untagged noun %s for an infinitive', translation => {
    const target = { ...word('target', translation), hy: 'իշխանություն' };
    const candidates = [word('walk', 'ходить', 'verbs'), word('think', 'думать', 'verbs'), word('write', 'писать', 'verbs'),
      word('noun1', 'документ', 'nouns'), word('noun2', 'закон', 'nouns'), word('noun3', 'понятие', 'nouns')];
    expect(new Set(selectWordDistractors(target, course([target, ...candidates]), candidates)))
      .toEqual(new Set(['документ', 'закон', 'понятие']));
  });

  it('prefers nearby nouns in the source over unrelated verbs and distant nouns', () => {
    const target = word('target', 'стол', 'nouns', 'Сущ.', 100);
    const candidates = [word('verb', 'думать', 'verbs', 'Сущ.', 100), word('distant', 'государство', 'nouns', 'Сущ.', 400),
      word('chair', 'стул', 'nouns', 'Сущ.', 101), word('shelf', 'полка', 'nouns', 'Сущ.', 102), word('bed', 'кровать', 'nouns', 'Сущ.', 103)];
    expect(new Set(selectWordDistractors(target, course([target, ...candidates]), candidates)))
      .toEqual(new Set(['стул', 'полка', 'кровать']));
  });

  it('keeps pronouns together even when adverbs share the broad other category', () => {
    const target = word('target', 'кто', 'other', 'местоимения', 10);
    const candidates = [word('early', 'рано', 'other', 'Наречия', 11), word('late', 'поздно', 'other', 'Наречия', 12),
      word('what', 'что', 'other', 'местоимения', 11), word('which', 'какой', 'other', 'местоимения', 12), word('whose', 'чей', 'other', 'местоимения', 13)];
    expect(new Set(selectWordDistractors(target, course([target, ...candidates]), candidates)))
      .toEqual(new Set(['что', 'какой', 'чей']));
  });

  it('prefers adjective forms for an untagged starter adjective', () => {
    const target = word('target', 'суверенный');
    const candidates = [word('state', 'государство'), word('vote', 'голосовать'), word('democratic', 'демократический'),
      word('social', 'социальный'), word('legal', 'правовой')];
    expect(new Set(selectWordDistractors(target, course([target, ...candidates]), candidates)))
      .toEqual(new Set(['демократический', 'социальный', 'правовой']));
  });

  it('normalizes orthographic ё/е for color families without changing displayed translations', () => {
    const target = word('target', 'оранжевый', 'other');
    const candidates = [word('noise', 'приятный', 'other'), word('black', 'чёрный', 'other'),
      word('green', 'зелёный', 'other'), word('yellow', 'жёлтый', 'other')];
    expect(selectWordDistractors(target, course([target, ...candidates]), candidates)).toEqual(['чёрный', 'зелёный', 'жёлтый']);
  });

  it('excludes shared Armenian forms and overlapping meanings across all four choices', () => {
    const target = { ...word('target', 'дом; жилище'), hy: 'տուն / տներ' };
    const candidates = [{ ...word('same', 'здание'), hy: ' ՏՈՒՆ ' }, word('overlap', 'ЖИЛИЩЕ / квартира'),
      { ...word('chair', 'стул; сиденье'), hy: 'աթոռ' }, { ...word('same_chair', 'кресло'), hy: 'աթոռ / աթոռներ' },
      word('seat', 'сиденье'), word('table', 'стол'), word('bed', 'кровать')];
    expect(selectWordDistractors(target, course([target, ...candidates]), candidates)).toEqual(['стул; сиденье', 'стол', 'кровать']);
  });

  it('fails clearly instead of inventing or repeating an alternative when only two valid distractors exist', () => {
    const target = word('target', 'дом');
    const candidates = [word('same', 'ДОМ'), word('table', 'стол'), word('chair', 'стул')];
    expect(() => selectWordDistractors(target, course([target, ...candidates]), candidates)).toThrow(/four non-overlapping/);
  });
});
