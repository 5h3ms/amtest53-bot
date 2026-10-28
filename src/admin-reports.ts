import { randomUUID } from 'node:crypto';
import { aggregateUsage, renderStats, type QuestionUsage, type UsageSummary } from './analytics.js';
import { examLessons, type Course } from './course.js';
import type { MessageView, UserState } from './engine.js';
import { renderReportPage } from './feedback.js';
import { topicProgress } from './question-review.js';
import type { StateStore } from './storage.js';

export const ADMIN_CACHE_TTL_MS = 10 * 60_000;
const LEASE_MS = 60_000;
const BUILD_LIMIT_MS = 20_000;
const CHUNK_SIZE = 100;
const CACHE_KEY = 'admin_cache_v1';
const button = (text: string, data: string) => ({ text, data });
const navigation = () => [[button('Статистика', 'admin:stats'), button('Участники', 'admin:users:0')],
  [button('Выбор вариантов', 'admin:questions:0'), button('Ошибки в заданиях', 'admin:reports:0')],
  [button('Главное меню', 'menu:home')]];
interface ReportRef { userId: number; reportId: string; at: number }
interface Snapshot {
  generation: string; courseVersion: string; createdAt: number; statsText: string;
  questionCount: number; reportCount: number;
}
interface Control {
  schema: 1; snapshot: Snapshot | null; lease: { token: string; until: number } | null; retired: string[]; retryAfter: number;
}
interface Chunk<T> { schema: 1; items: T[] }
const generationValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const prefix = (generation: string) => `${CACHE_KEY}_g_${generation}_`;
const chunkKey = (generation: string, kind: 'q' | 'r', page: number) => `${prefix(generation)}${kind}_${page}`;
const empty = (): Control => ({ schema: 1, snapshot: null, lease: null, retired: [], retryAfter: 0 });
function control(raw: unknown): Control {
  const value = raw as Control | null;
  if (!value || value.schema !== 1 || !Array.isArray(value.retired)) return empty();
  return { schema: 1, snapshot: value.snapshot && generationValid(value.snapshot.generation) &&
    Number.isFinite(value.snapshot.createdAt) && typeof value.snapshot.statsText === 'string' ? value.snapshot : null,
  lease: value.lease && generationValid(value.lease.token) && Number.isFinite(value.lease.until) ? value.lease : null,
  retired: value.retired.filter(generationValid), retryAfter: Number.isFinite(value.retryAfter) ? value.retryAfter : 0 };
}
function registered(raw: unknown, key: string): UserState | null {
  const user = raw as UserState | null;
  return user?.schema === 1 && Number.isSafeInteger(user.userId) && user.userId > 0 &&
    user.chatId === user.userId && key === `u_${user.userId}` && Number.isFinite(user.updatedAt) &&
    Array.isArray(user.completedLessons) && user.cards && typeof user.cards === 'object' ? user : null;
}
function compact(user: UserState): UserState { return { ...user, session: null, outbox: [], processedEvents: [] }; }
function mergeUsage(target: UsageSummary, incoming: UsageSummary): void {
  for (const field of ['users', 'observedUsers', 'active24h', 'active7d', 'active30d', 'learners7d'] as const) target[field] += incoming[field];
  if (incoming.historyStartedAt !== null) target.historyStartedAt = Math.min(target.historyStartedAt ?? incoming.historyStartedAt, incoming.historyStartedAt);
  for (const field of Object.keys(target.totals) as Array<keyof UsageSummary['totals']>) target.totals[field] += incoming.totals[field];
  target.return7d.eligible += incoming.return7d.eligible; target.return7d.returned += incoming.return7d.returned;
  const days = new Map(target.dailyActive.map(day => [day.date, day.users]));
  for (const day of incoming.dailyActive) days.set(day.date, (days.get(day.date) ?? 0) + day.users);
  target.dailyActive = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, users]) => ({ date, users }));
}
function mergeQuestion(questions: Map<string, QuestionUsage>, identity: string, question: QuestionUsage): void {
  const previous = questions.get(identity);
  if (!previous) { questions.set(identity, structuredClone(question)); return; }
  previous.firstAt = Math.min(previous.firstAt, question.firstAt); previous.lastAt = Math.max(previous.lastAt, question.lastAt);
  for (const field of ['answers', 'correct', 'correctUnhinted', 'hintedAnswers'] as const) previous[field] += question[field];
  for (const [key, option] of Object.entries(question.options)) {
    if (previous.options[key]) previous.options[key]!.count += option.count;
    else previous.options[key] = { ...option };
  }
}
const stamp = (snapshot: Snapshot, now: number) => `\n\nСводка обновлена: ${new Date(snapshot.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. Обновляется при обращении раз в 10 минут.${now - snapshot.createdAt >= ADMIN_CACHE_TTL_MS ? ' Показана последняя успешно собранная сводка.' : ''}`;
const pageNumber = (action: string, count: number) => {
  const requested = Number(action.split(':')[2]);
  return Number.isSafeInteger(requested) ? Math.max(0, Math.min(requested, count - 1)) : 0;
};
const pageButtons = (kind: 'reports' | 'questions', page: number, count: number) => {
  const row = [];
  if (page > 0) row.push(button('← Назад', `admin:${kind}:${page - 1}`));
  if (page + 1 < count) row.push(button('Дальше →', `admin:${kind}:${page + 1}`));
  return row.length ? [row] : [];
};

/** The caller must enforce administrator access before invoking this service. */
export class AdminReports {
  private readonly store: StateStore;
  private readonly course: Course;
  constructor(options: { store: StateStore; course: Course }) { this.store = options.store; this.course = options.course; }

  async view(action: string, now: number, requester?: UserState): Promise<MessageView> {
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid report time');
    if (action.startsWith('admin:users:')) return this.users(action, now);
    let snapshot = await this.snapshot(now, requester);
    if (!snapshot) return { text: 'Сводка обновляется. Откройте статистику немного позже.', buttons: navigation() };
    // A refresh may retire a generation between the manifest and chunk reads. Retry with its successor.
    for (let attempt = 0; attempt < 2; attempt++) {
      const rendered = await this.render(action, snapshot, now);
      if (rendered) return rendered;
      const current = control(await this.store.read(CACHE_KEY)).snapshot;
      if (!current || current.generation === snapshot.generation || current.courseVersion !== this.course.version) break;
      snapshot = current;
    }
    return { text: 'Сводка обновилась. Откройте нужный раздел ещё раз.', buttons: navigation() };
  }

  private fresh(snapshot: Snapshot | null, now: number): snapshot is Snapshot {
    return Boolean(snapshot && snapshot.courseVersion === this.course.version && now >= snapshot.createdAt &&
      now - snapshot.createdAt < ADMIN_CACHE_TTL_MS);
  }
  private compatible(snapshot: Snapshot | null): Snapshot | null {
    return snapshot?.courseVersion === this.course.version ? snapshot : null;
  }

  private async snapshot(now: number, requester?: UserState): Promise<Snapshot | null> {
    const deadline = Date.now() + BUILD_LIMIT_MS;
    const checkBudget = () => { if (Date.now() >= deadline) throw new Error('Report refresh exceeded its time budget'); };
    const leaseTime = () => now + Date.now() - (deadline - BUILD_LIMIT_MS);
    const existing = control(await this.store.read(CACHE_KEY));
    if (this.fresh(existing.snapshot, now)) return existing.snapshot;
    if (existing.retryAfter > now) return this.compatible(existing.snapshot);
    const token = randomUUID().replaceAll('-', '');
    const locked = await this.store.update(CACHE_KEY, raw => {
      const current = control(raw);
      if (this.fresh(current.snapshot, now) || current.retryAfter > now || (current.lease && current.lease.until > now)) {
        return { state: raw, result: { acquired: false, snapshot: this.compatible(current.snapshot) } };
      }
      if (current.lease) current.retired.push(current.lease.token);
      current.lease = { token, until: now + LEASE_MS };
      return { state: current, result: { acquired: true, snapshot: this.compatible(current.snapshot) } };
    });
    if (!locked.acquired) return locked.snapshot;
    try {
      checkBudget();
      await this.cleanup(deadline);
      checkBudget();
      const summary = aggregateUsage([], now), questions = new Map<string, QuestionUsage>(), refs: ReportRef[] = [];
      let requesterFound = false;
      const consume = (users: UserState[]) => {
        mergeUsage(summary, aggregateUsage(users.map(user => ({ ...user,
          ...(user.analytics ? { analytics: { ...user.analytics, questions: {} } } : {}) })), now));
        for (const user of users) {
          if (user.userId === requester?.userId) requesterFound = true;
          for (const report of user.feedback?.reports ?? []) refs.push({ userId: user.userId, reportId: report.id, at: report.at });
          const analytics = user.analytics;
          // Use the original full-version identity, not the clipped display labels.
          if (analytics?.schema === 1 && Number.isFinite(analytics.startedAt) && analytics.days && analytics.questions) {
            for (const [identity, question] of Object.entries(analytics.questions)) mergeQuestion(questions, identity, question);
          }
        }
      };
      let afterKey: string | undefined;
      do {
        checkBudget();
        const page = await this.store.listPage('u_', { afterKey, limit: 100 });
        checkBudget();
        const users: UserState[] = [];
        for (const record of page.records) {
          const user = registered(record.state, record.key);
          if (user) users.push(compact(user));
        }
        consume(users);
        if (page.nextCursor === null) break;
        if (afterKey !== undefined && page.nextCursor <= afterKey) throw new Error('Invalid report page cursor');
        afterKey = page.nextCursor;
      } while (true);
      // The owner's first command can create their user document after this read-only preparation.
      if (requester && registered(requester, `u_${requester.userId}`) && !requesterFound) consume([compact(requester)]);
      summary.questions = [...questions.values()].sort((a, b) => ((b.answers - b.correct) / b.answers) - ((a.answers - a.correct) / a.answers) || b.answers - a.answers);
      refs.sort((a, b) => b.at - a.at || a.reportId.localeCompare(b.reportId) || a.userId - b.userId);
      checkBudget();
      await this.writeChunks(token, 'q', summary.questions, checkBudget, leaseTime);
      await this.writeChunks(token, 'r', refs, checkBudget, leaseTime);
      const next: Snapshot = { generation: token, courseVersion: this.course.version, createdAt: now,
        statsText: renderStats(summary), questionCount: summary.questions.length, reportCount: refs.length };
      checkBudget();
      const publishedAt = leaseTime();
      const published = await this.store.update(CACHE_KEY, raw => {
        const current = control(raw);
        if (current.lease?.token !== token || current.lease.until <= publishedAt) return { state: raw, result: false };
        if (current.snapshot) current.retired.push(current.snapshot.generation);
        current.snapshot = next; current.lease = null; current.retryAfter = 0;
        return { state: current, result: true };
      });
      if (!published) throw new Error('Report refresh lease was replaced');
      await this.cleanup(deadline);
      return next;
    } catch {
      // The next caller can recover the expired lease and retire partial chunks. Do not add
      // more network operations after the refresh budget has already been consumed.
      if (Date.now() >= deadline) return locked.snapshot;
      // A publish response can be lost after commit. Never delete a generation which was published.
      const recovered = await this.store.update(CACHE_KEY, raw => {
        const current = control(raw);
        if (current.snapshot?.generation !== token && !current.retired.includes(token)) current.retired.push(token);
        if (current.lease?.token === token) { current.lease = null; current.retryAfter = now + LEASE_MS; }
        return { state: current, result: this.compatible(current.snapshot) };
      });
      await this.cleanup(deadline);
      return recovered;
    }
  }

  private async writeChunks<T>(generation: string, kind: 'q' | 'r', items: T[], checkBudget: () => void, leaseTime: () => number): Promise<void> {
    for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
      checkBudget();
      const chunk: Chunk<T> = { schema: 1, items: items.slice(offset, offset + CHUNK_SIZE) };
      if (Buffer.byteLength(JSON.stringify(chunk), 'utf8') > 800 * 1024) throw new Error('Report cache chunk too large');
      const writtenAt = leaseTime();
      await this.store.update(chunkKey(generation, kind, offset / CHUNK_SIZE), () => ({ state: chunk, result: undefined }), {
        key: CACHE_KEY,
        check: raw => { const current = control(raw); return current.lease?.token === generation && current.lease.until > writtenAt; },
      });
      checkBudget();
    }
  }

  private async cleanup(deadline: number): Promise<void> {
    try {
      const checkBudget = () => { if (Date.now() >= deadline) throw new Error('Report cleanup time budget exhausted'); };
      checkBudget();
      const current = control(await this.store.read(CACHE_KEY));
      for (const generation of [...new Set(current.retired)]) {
        if (generation === current.snapshot?.generation || generation === current.lease?.token) continue;
        let afterKey: string | undefined;
        do {
          checkBudget();
          const page = await this.store.listPage(prefix(generation), { afterKey, limit: 100 });
          for (const record of page.records) { checkBudget(); await this.store.delete(record.key); }
          if (page.nextCursor === null) break;
          afterKey = page.nextCursor;
        } while (true);
        checkBudget();
        await this.store.update(CACHE_KEY, raw => {
          const latest = control(raw);
          latest.retired = latest.retired.filter(item => item !== generation);
          return { state: latest, result: undefined };
        });
      }
    } catch { /* Retired generation remains listed, and a later refresh retries cleanup. */ }
  }

  private async item<T>(snapshot: Snapshot, kind: 'q' | 'r', index: number): Promise<T | null> {
    const raw = await this.store.read(chunkKey(snapshot.generation, kind, Math.floor(index / CHUNK_SIZE))) as Chunk<T> | null;
    return raw?.schema === 1 && Array.isArray(raw.items) ? raw.items[index % CHUNK_SIZE] ?? null : null;
  }
  private async render(action: string, snapshot: Snapshot, now: number): Promise<MessageView | null> {
    if (action.startsWith('admin:questions:')) {
      if (!snapshot.questionCount) return { text: `Ответов на вопросы с начала сбора ещё нет.${stamp(snapshot, now)}`, buttons: navigation() };
      const page = pageNumber(action, snapshot.questionCount), question = await this.item<QuestionUsage>(snapshot, 'q', page);
      if (!question) return null;
      const options = Object.values(question.options).sort((a, b) => b.count - a.count)
        .map(option => `${option.correct ? '✓' : '•'} ${option.text}: ${option.count}/${question.answers}`);
      return { text: `Выбор вариантов · ${page + 1}/${snapshot.questionCount}\n${question.id}\nВерсия: ${question.version}\n\n${question.prompt}\n\nОтветов: ${question.answers}; правильно: ${question.correct}; с подсказкой: ${question.hintedAnswers}\n${options.join('\n')}\n\nПорядок кнопок не влияет на счётчики. Данные относятся к сохранённой версии вопроса с начала её сбора; старые записи могут вытесняться.${stamp(snapshot, now)}`,
        buttons: [...pageButtons('questions', page, snapshot.questionCount), ...navigation()] };
    }
    if (action.startsWith('admin:reports:')) {
      if (!snapshot.reportCount) return { text: `Сообщений об ошибках пока нет.${stamp(snapshot, now)}`, buttons: navigation() };
      const page = pageNumber(action, snapshot.reportCount), ref = await this.item<ReportRef>(snapshot, 'r', page);
      if (!ref) return null;
      const user = registered(await this.store.read(`u_${ref.userId}`), `u_${ref.userId}`);
      const report = user?.feedback?.reports.find(report => report.id === ref.reportId);
      const text = report ? renderReportPage([{ userId: ref.userId, report }]).text.replace('Сообщение об ошибке 1/1', `Сообщение об ошибке ${page + 1}/${snapshot.reportCount}`)
        : `Сообщение ${page + 1}/${snapshot.reportCount} больше не хранится. Список обновится со следующей сводкой.`;
      return { text: text + stamp(snapshot, now), buttons: [...pageButtons('reports', page, snapshot.reportCount), ...navigation()] };
    }
    return { text: snapshot.statsText + stamp(snapshot, now), buttons: navigation() };
  }

  private async users(action: string, now: number): Promise<MessageView> {
    const [, , direction, cursor] = action.split(':');
    const validCursor = typeof cursor === 'string' && /^u_[1-9]\d{0,15}$/.test(cursor) && Number.isSafeInteger(Number(cursor.slice(2)));
    const mode = validCursor && (direction === 'a' || direction === 'b') ? direction : 'first';
    const page = await this.store.listPage('u_', { limit: 5,
      ...(mode === 'a' ? { afterKey: cursor } : mode === 'b' ? { beforeKey: cursor } : {}) });
    const lessons = examLessons(this.course);
    const lines = page.records.flatMap(record => {
      const user = registered(record.state, record.key);
      if (!user) return [];
      const topics = topicProgress(this.course, user.questionProgress ?? {}, now);
      return [`ID ${user.userId}\nУроки маршрута: ${lessons.filter(lesson => user.completedLessons.includes(lesson.id)).length}/${lessons.length}; слов в работе: ${Object.keys(user.cards).length}\nВопросы освоены: ${topics.reduce((sum, topic) => sum + topic.mastered, 0)}/${this.course.questions.length}; повторить: ${topics.reduce((sum, topic) => sum + topic.due, 0)}\nПоследняя активность: ${new Date(user.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`];
    });
    const first = page.records[0]?.key, last = page.records.at(-1)?.key, buttons = [];
    if (first && (mode === 'a' || (mode === 'b' && page.nextCursor !== null))) buttons.push(button('← Назад', `admin:users:b:${first}`));
    if (last && (mode === 'b' || page.nextCursor !== null)) buttons.push(button('Дальше →', `admin:users:a:${last}`));
    return { text: `Участники · по ID\n\n${lines.length ? lines.join('\n\n') : 'На этой странице участников нет.'}\n\nПрогресс показан на момент открытия страницы.`,
      buttons: [...(buttons.length ? [buttons] : []), ...(mode !== 'first' ? [[button('В начало списка', 'admin:users:0')]] : []), ...navigation()] };
  }
}
