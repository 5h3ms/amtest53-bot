import { createHash } from 'node:crypto';

export const ANALYTICS_DAYS = 90;
export const ANALYTICS_QUESTION_LIMIT = 200;
export const ANALYTICS_MAX_BYTES = 128 * 1024;
const DAY = 86_400_000;
const zero = () => ({ active: 0, starts: 0, completed: 0, answers: 0, correctUnhinted: 0, hintedAnswers: 0, hints: 0,
  exams: 0, passedExams: 0, examScore: 0, examTotal: 0 });
export type DailyUsage = ReturnType<typeof zero>;
export interface QuestionUsage {
  id: string; version: string; prompt: string; firstAt: number; lastAt: number;
  answers: number; correct: number; correctUnhinted: number; hintedAnswers: number;
  options: Record<string, { text: string; correct: boolean; count: number }>;
}
export interface UsageAnalytics {
  schema: 1; startedAt: number; firstActiveAt?: number; days: Record<string, DailyUsage>; questions: Record<string, QuestionUsage>;
}
export interface AnalyticsQuestion { id: string; version: string; prompt: string; options: string[]; correctIndex: number }
export type UsageEvent = { kind: 'active' | 'start' | 'complete' | 'hint' }
  | { kind: 'answer'; correct: boolean; hinted: boolean; selected: number; question?: AnalyticsQuestion }
  | { kind: 'exam'; score: number; total: number; passed: boolean };
export interface AnalyticsUser { userId: number; updatedAt: number; analytics?: UsageAnalytics }

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const normalize = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ');
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const short = (value: string, limit: number) => normalize(value).slice(0, limit);
const isAnalytics = (value: UsageAnalytics | undefined): value is UsageAnalytics =>
  value?.schema === 1 && Number.isFinite(value.startedAt) && Boolean(value.days) && Boolean(value.questions);

/** Call only for accepted events inside the user's existing deduplicated transaction. */
export function recordUsage(previous: UsageAnalytics | undefined, event: UsageEvent, now: number): UsageAnalytics {
  if (!Number.isFinite(now)) throw new Error('Invalid analytics time');
  const state: UsageAnalytics = isAnalytics(previous) ? structuredClone(previous)
    : { schema: 1, startedAt: now, days: {}, questions: {} };
  const today = utcDay(now), cutoff = utcDay(now - (ANALYTICS_DAYS - 1) * DAY);
  for (const day of Object.keys(state.days)) if (day < cutoff || day > today) delete state.days[day];
  const day = state.days[today] ??= zero();
  if (event.kind === 'active') { day.active = 1; state.firstActiveAt ??= now; }
  if (event.kind === 'start') day.starts++;
  if (event.kind === 'complete') day.completed++;
  if (event.kind === 'hint') day.hints++;
  if (event.kind === 'exam') {
    if (!Number.isSafeInteger(event.score) || !Number.isSafeInteger(event.total) || event.total < 1 || event.score < 0 || event.score > event.total) {
      throw new Error('Invalid analytics exam result');
    }
    day.exams++; day.passedExams += Number(event.passed); day.examScore += event.score; day.examTotal += event.total;
  }
  if (event.kind === 'answer') {
    day.answers++; day.correctUnhinted += Number(event.correct && !event.hinted); day.hintedAnswers += Number(event.hinted);
    const question = event.question;
    if (question) {
      if (!question.options[event.selected] || !question.options[question.correctIndex]) throw new Error('Invalid analytics answer');
      const identity = hash(JSON.stringify([question.version, question.id]));
      const current = state.questions[identity] ??= { id: short(question.id, 40), version: short(question.version, 100),
        prompt: short(question.prompt, 120), firstAt: now, lastAt: now, answers: 0, correct: 0, correctUnhinted: 0, hintedAnswers: 0, options: {} };
      current.lastAt = now; current.answers++; current.correct += Number(event.correct);
      current.correctUnhinted += Number(event.correct && !event.hinted); current.hintedAnswers += Number(event.hinted);
      for (const [index, option] of question.options.entries()) {
        const optionText = normalize(option);
        current.options[hash(optionText)] ??= { text: short(optionText, 100), correct: index === question.correctIndex, count: 0 };
      }
      // Hash the complete normalized option, before clipping its display label. Shuffling cannot merge different answers.
      const selectedText = normalize(question.options[event.selected]!);
      const choiceKey = hash(selectedText);
      const choice = current.options[choiceKey] ??= { text: short(selectedText, 100),
        correct: event.selected === question.correctIndex, count: 0 };
      choice.count++;
      // A valid bank has four choices; keep legacy or changed snapshots bounded too.
      if (Object.keys(current.options).length > 8) {
        const keep = Object.entries(current.options).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
        current.options = Object.fromEntries(keep);
      }
    }
  }
  state.questions = Object.fromEntries(Object.entries(state.questions)
    .sort((a, b) => b[1].lastAt - a[1].lastAt || a[0].localeCompare(b[0])).slice(0, ANALYTICS_QUESTION_LIMIT));
  // Leave room in the shared Firestore document for sessions, progress and reports.
  const oldestFirst = Object.keys(state.questions).reverse();
  while (Buffer.byteLength(JSON.stringify(state), 'utf8') > ANALYTICS_MAX_BYTES && oldestFirst.length) {
    delete state.questions[oldestFirst.shift()!];
  }
  return state;
}

export interface UsageSummary {
  users: number; observedUsers: number; active24h: number; active7d: number; active30d: number;
  learners7d: number; historyStartedAt: number | null; totals: DailyUsage;
  dailyActive: Array<{ date: string; users: number }>;
  return7d: { eligible: number; returned: number };
  questions: QuestionUsage[];
}

/** Read-only snapshot. Daily totals cover the current and previous 89 UTC calendar days. */
export function aggregateUsage(users: readonly AnalyticsUser[], now: number): UsageSummary {
  const today = utcDay(now), cutoff = utcDay(now - (ANALYTICS_DAYS - 1) * DAY), sevenDays = utcDay(now - 6 * DAY);
  const result: UsageSummary = { users: users.length, observedUsers: 0, active24h: 0, active7d: 0, active30d: 0,
    learners7d: 0, historyStartedAt: null, totals: zero(), dailyActive: [], return7d: { eligible: 0, returned: 0 }, questions: [] };
  const activity = new Map<string, number>(), questions = new Map<string, QuestionUsage>();
  for (const user of users) {
    const age = now - user.updatedAt;
    if (age >= 0 && age <= DAY) result.active24h++;
    if (age >= 0 && age <= 7 * DAY) result.active7d++;
    if (age >= 0 && age <= 30 * DAY) result.active30d++;
    const analytics = user.analytics;
    if (!isAnalytics(analytics)) continue;
    result.observedUsers++;
    result.historyStartedAt = Math.min(result.historyStartedAt ?? analytics.startedAt, analytics.startedAt);
    let learned = false;
    for (const [date, counts] of Object.entries(analytics.days)) {
      if (date < cutoff || date > today) continue;
      if (counts.active > 0) activity.set(date, (activity.get(date) ?? 0) + 1);
      if (date >= sevenDays && counts.answers > 0) learned = true;
      for (const metric of Object.keys(result.totals) as Array<keyof DailyUsage>) result.totals[metric] += counts[metric] ?? 0;
    }
    result.learners7d += Number(learned);
    // Only mature cohorts whose first week is still fully inside retained history.
    const firstActive = analytics.firstActiveAt;
    const firstDay = firstActive === undefined ? undefined : utcDay(firstActive);
    const firstDayStart = firstDay === undefined ? undefined : Date.parse(`${firstDay}T00:00:00Z`);
    if (firstDayStart !== undefined && firstDay !== undefined && now >= firstDayStart + 7 * DAY && firstDay >= cutoff) {
      result.return7d.eligible++;
      const lastDay = utcDay(firstDayStart + 6 * DAY);
      result.return7d.returned += Number(Object.entries(analytics.days).some(([date, counts]) => counts.active > 0 && date > firstDay && date <= lastDay));
    }
    for (const [identity, entry] of Object.entries(analytics.questions)) {
      const aggregate = questions.get(identity);
      if (!aggregate) { questions.set(identity, structuredClone(entry)); continue; }
      aggregate.firstAt = Math.min(aggregate.firstAt, entry.firstAt); aggregate.lastAt = Math.max(aggregate.lastAt, entry.lastAt);
      aggregate.answers += entry.answers; aggregate.correct += entry.correct; aggregate.correctUnhinted += entry.correctUnhinted;
      aggregate.hintedAnswers += entry.hintedAnswers;
      for (const [choiceKey, choice] of Object.entries(entry.options)) {
        const previous = aggregate.options[choiceKey];
        if (previous) previous.count += choice.count;
        else aggregate.options[choiceKey] = { ...choice };
      }
    }
  }
  result.dailyActive = [...activity].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, users: count }));
  result.questions = [...questions.values()].sort((a, b) =>
    ((b.answers - b.correct) / b.answers) - ((a.answers - a.correct) / a.answers) || b.answers - a.answers);
  return result;
}

const percentage = (count: number, total: number) => total ? `${Math.round(count / total * 100)}% (${count}/${total})` : 'нет данных';
export function renderStats(summary: UsageSummary): string {
  const t = summary.totals;
  const lines = ['Статистика бота', '', `Пользователей: ${summary.users}`,
    `Активны за 24 ч / 7 / 30 дней: ${summary.active24h} / ${summary.active7d} / ${summary.active30d}`,
    `Ответили хотя бы раз за последние 7 календарных дней: ${summary.learners7d}`, '',
    `История: ${summary.historyStartedAt === null ? 'сбор ещё не начался' : `с ${utcDay(summary.historyStartedAt)}`}. Храним 90 календарных дней (UTC).`,
    `Начатые / завершённые занятия: ${t.starts} / ${t.completed}`,
    `Ответы без подсказок, правильно: ${percentage(t.correctUnhinted, t.answers)}`,
    `Ответы с подсказкой: ${percentage(t.hintedAnswers, t.answers)}; открытий подсказок: ${t.hints}`,
    `Завершённые тесты: ${t.exams}; успешные: ${percentage(t.passedExams, t.exams)}`,
    `Баллы тестов: ${t.exams ? `${(t.examScore / t.exams).toFixed(1)} в среднем; ${t.examScore}/${t.examTotal} суммарно` : 'нет данных'}`,
    `Вернулись в другой день первых 7 календарных дней (UTC): ${summary.return7d.eligible ? percentage(summary.return7d.returned, summary.return7d.eligible) : 'нет полных первых недель в сохранённой истории'}`];
  const recentDays = summary.dailyActive.slice(-7);
  if (recentDays.length) lines.push('', 'Последние дни с активностью (UTC):', ...recentDays.map(day => `${day.date}: ${day.users}`));
  const difficulties = summary.questions.filter(question => question.answers >= 3 && question.correct < question.answers).slice(0, 3);
  lines.push('', 'Ошибки по сохранённым версиям вопросов (с начала их сбора):');
  if (!difficulties.length) lines.push('Для сравнения нужны хотя бы 3 ответа на вопрос и ошибки.');
  for (const question of difficulties) {
    lines.push(`${question.id}: ${question.prompt}`, `Версия: ${question.version}`,
      `Ошибки: ${percentage(question.answers - question.correct, question.answers)}; с подсказкой: ${question.hintedAnswers}.`);
    for (const choice of Object.values(question.options).filter(option => !option.correct).sort((a, b) => b.count - a.count).slice(0, 2)) {
      lines.push(`Выбрали «${choice.text}»: ${choice.count}/${question.answers}`);
    }
  }
  lines.push('', 'До начала сбора история не восстанавливается. Активность включает меню; учебная активность требует ответа.',
    'Детализация ответов ограничена последними версиями вопросов; старые записи могут вытесняться.');
  return lines.join('\n');
}
