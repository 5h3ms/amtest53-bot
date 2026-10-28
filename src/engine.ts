import { createHash } from 'node:crypto';
import type { Course, Question, Vocabulary } from './course.js';
import { examLessons, examVocabulary } from './course.js';
import type { StateStore } from './storage.js';
import { selectWordDistractors } from './vocabulary-choices.js';
import { updateQuestionProgress, selectPracticeQuestions, topicProgress, type QuestionProgress } from './question-review.js';
import { recordUsage, aggregateUsage, renderStats, type UsageAnalytics } from './analytics.js';
import { beginFeedback, chooseFeedbackCategory, pendingFeedback, cancelFeedback, submitFeedback,
  collectReports, renderReportPage, FEEDBACK_CATEGORY_LABELS, type FeedbackState } from './feedback.js';

export interface MessageView { text: string; buttons?: Array<Array<{ text: string; data: string }>> }
export interface PendingDelivery { id: string; userId: number; chatId: number; view: MessageView }
export interface BotEvent { userId: number; chatId: number; eventId: string; text?: string; action?: string; now?: number }
type Step = { kind: 'word'; word: Vocabulary; choices: string[]; correctIndex: number }
  | { kind: 'question'; question: Question };
type Answer = { step: number; selected: number; correct: boolean; hinted: boolean };
export interface StudySession {
  id: string; kind: 'lesson' | 'practice' | 'exam' | 'review'; title: string;
  lessonId: string | null; contentVersion: string; steps: Step[]; index: number;
  answers: Answer[]; hints: number[]; feedback: boolean;
  readingHints?: number[];
  startedAt: number; deadlineAt: number | null; endedAt: number | null;
}
interface CardProgress { level: number; dueAt: number; seen: number; mistakes: number }
interface DeliveryRecord extends PendingDelivery { leaseUntil: number; createdAt: number; expiresAt: number | null }
interface ExamResult { at: number; score: number; total: number; timedOut: boolean; version: string }
export interface UserState {
  schema: 1; userId: number; chatId: number; createdAt: number; updatedAt: number;
  session: StudySession | null; cards: Record<string, CardProgress>; questionMistakes: Record<string, number>;
  completedLessons: string[]; attempts: number; correct: number; exams: ExamResult[];
  questionProgress?: Record<string, QuestionProgress>;
  analytics?: UsageAnalytics;
  feedback?: FeedbackState;
  reminders: { enabled: boolean; time: string; timeZone: string; lastSentDate: string | null };
  blocked: boolean; processedEvents: string[]; outbox: DeliveryRecord[];
}
const DAY = 86400_000;
const INTERVALS = [1, 3, 7, 14, 30];
const MAX_OUTBOX = 30;
const LESSONS_PER_PAGE = 8;
const CATEGORY_LABELS = { nouns: 'Существительные', verbs: 'Глаголы', other: 'Другие слова' } as const;
type VocabularyCategory = keyof typeof CATEGORY_LABELS;
const button = (text: string, data: string) => ({ text, data });
const menuButton = [button('Главное меню', 'menu:home')];
const key = (id: number) => `u_${id}`;
const inputText = (value: string | undefined) => (value ?? '').normalize('NFC')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
function initial(userId: number, chatId: number, now: number): UserState {
  return { schema: 1, userId, chatId, createdAt: now, updatedAt: now, session: null,
    cards: {}, questionMistakes: {}, questionProgress: {}, completedLessons: [], attempts: 0, correct: 0, exams: [],
    reminders: { enabled: false, time: '19:00', timeZone: 'Asia/Qyzylorda', lastSentDate: null },
    blocked: false, processedEvents: [], outbox: [] };
}
function parseState(raw: unknown): UserState {
  const state = raw as UserState;
  if (!state || state.schema !== 1 || !Array.isArray(state.outbox) || !Array.isArray(state.processedEvents)) {
    throw new Error('Unsupported user state; restore a compatible backup.');
  }
  return state;
}
function shuffled<T>(items: readonly T[], seed: string): T[] {
  return items.map(value => ({ value, rank: createHash('sha256').update(seed + JSON.stringify(value)).digest('hex') }))
    .sort((a, b) => a.rank.localeCompare(b.rank)).map(item => item.value);
}
function dateParts(now: number, zone: string): { date: string; time: string } {
  const pieces = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (name: string) => pieces.find(x => x.type === name)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
export function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}

export class LearningEngine {
  private readonly store: StateStore;
  private readonly course: Course;
  private readonly allowed: Set<number>;
  private readonly admins: Set<number>;
  private readonly accessMode: 'private' | 'public';
  constructor(options: { store: StateStore; course: Course; allowedUserIds: number[]; adminUserIds: number[]; accessMode?: 'private' | 'public' }) {
    this.store = options.store; this.course = options.course;
    this.allowed = new Set([...options.allowedUserIds, ...options.adminUserIds]);
    this.admins = new Set(options.adminUserIds);
    this.accessMode = options.accessMode ?? 'private';
  }
  private canAccess(userId: number): boolean {
    return Number.isSafeInteger(userId) && userId > 0 && (this.accessMode === 'public' || this.allowed.has(userId));
  }
  async handle(event: BotEvent): Promise<PendingDelivery[]> {
    if (!this.canAccess(event.userId) || event.chatId !== event.userId) return [];
    const now = event.now ?? Date.now();
    if (!Number.isFinite(now) || !event.eventId || event.eventId.length > 100) throw new Error('Invalid event');
    const command = inputText(event.text).split('@')[0];
    const adminRequest = command === '/stats' || command === '/reports' || event.action?.startsWith('admin:');
    const users = adminRequest && this.admins.has(event.userId) ? await this.registeredUsers() : undefined;
    return this.store.update(key(event.userId), raw => {
      const user = raw === null ? initial(event.userId, event.chatId, now) : parseState(raw);
      if (user.userId !== event.userId || user.chatId !== event.chatId) return { state: user, result: [] };
      this.pruneReminders(user, now);
      if (user.processedEvents.includes(event.eventId)) return { state: user, result: this.pending(user) };
      user.updatedAt = now; user.blocked = false;
      user.analytics = recordUsage(user.analytics, { kind: 'active' }, now);
      let view: MessageView;
      if (this.expireExam(user, now)) {
        // A timer expiring while a report is being written must not discard its description.
        const feedbackInput = event.action?.startsWith('report:') || event.action?.startsWith('feedback:') ||
          (pendingFeedback(user.feedback, now) && inputText(event.text) && !inputText(event.text).startsWith('/'));
        view = feedbackInput ? this.routeFeedback(user, event, now) ?? this.renderSession(user) : this.renderSession(user);
      } else {
        view = this.route(user, event, now, users);
      }
      this.pruneReminders(user, now);
      user.processedEvents.push(event.eventId);
      user.processedEvents = user.processedEvents.slice(-200);
      this.enqueue(user, `event_${event.eventId}`, view, now);
      return { state: user, result: this.pending(user) };
    });
  }
  async claim(userId: number, id: string): Promise<boolean> {
    if (!this.canAccess(userId)) return false;
    return this.store.update(key(userId), raw => {
      if (raw === null) return { state: null, result: false };
      const user = parseState(raw), now = Date.now();
      if (user.userId !== userId || user.chatId !== userId) return { state: user, result: false };
      this.pruneReminders(user, now);
      const item = user.outbox.find(x => x.id === id);
      if (user.blocked) return { state: user, result: false };
      if (!item || item.userId !== userId || item.chatId !== userId || item.leaseUntil > now) return { state: user, result: false };
      item.leaseUntil = now + 30_000;
      return { state: user, result: true };
    });
  }
  async acknowledge(userId: number, id: string): Promise<void> {
    await this.store.update(key(userId), raw => {
      if (raw === null) return { state: null, result: undefined };
      const user = parseState(raw); user.outbox = user.outbox.filter(x => x.id !== id);
      return { state: user, result: undefined };
    });
  }
  async release(userId: number, id: string): Promise<void> {
    await this.store.update(key(userId), raw => {
      if (raw === null) return { state: null, result: undefined };
      const user = parseState(raw), item = user.outbox.find(x => x.id === id);
      if (item) item.leaseUntil = 0;
      return { state: user, result: undefined };
    });
  }
  async suppressNotifications(userId: number): Promise<void> {
    await this.store.update(key(userId), raw => {
      if (raw === null) return { state: null, result: undefined };
      const user = parseState(raw); user.reminders.enabled = false; user.blocked = true; user.outbox = [];
      return { state: user, result: undefined };
    });
  }
  async maintenance(now = Date.now()): Promise<PendingDelivery[]> {
    const pending: PendingDelivery[] = [];
    if (this.accessMode === 'private') {
      // A revoked private participant receives no scheduled deliveries.
      for (const userId of this.allowed) pending.push(...await this.maintainUser(userId, now));
      return pending;
    }
    let afterKey: string | undefined;
    while (true) {
      const page = await this.store.listPage('u_', { afterKey, limit: 100 });
      for (const record of page.records) {
        const user = this.registeredUser(record.state, record.key);
        // Read-only snapshots avoid a transaction/write for every idle registered user.
        if (user && this.needsMaintenance(user, now)) pending.push(...await this.maintainUser(user.userId, now));
      }
      if (page.nextCursor === null) break;
      if (afterKey !== undefined && page.nextCursor <= afterKey) throw new Error('Invalid maintenance page cursor');
      afterKey = page.nextCursor;
    }
    return pending;
  }
  private registeredUser(raw: unknown, recordKey: string): UserState | null {
    try {
      const user = parseState(raw);
      if (!this.canAccess(user.userId) || key(user.userId) !== recordKey || user.chatId !== user.userId ||
        typeof user.blocked !== 'boolean' || !Array.isArray(user.exams) || !Array.isArray(user.completedLessons) ||
        !user.reminders || typeof user.reminders.enabled !== 'boolean' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(user.reminders.time) || typeof user.reminders.timeZone !== 'string') return null;
      if (user.reminders.enabled && !validTimeZone(user.reminders.timeZone)) return null;
      if (user.session !== null && (!user.session || typeof user.session.id !== 'string' ||
        !Array.isArray(user.session.steps) || !Array.isArray(user.session.answers) ||
        user.session.answers.some(answer => !answer || typeof answer.correct !== 'boolean') ||
        (user.session.deadlineAt !== null && !Number.isFinite(user.session.deadlineAt)))) return null;
      if (user.outbox.some(item => !item || typeof item.id !== 'string' || item.userId !== user.userId ||
        item.chatId !== user.userId || !item.view || typeof item.view.text !== 'string')) return null;
      return user;
    } catch {
      return null;
    }
  }
  private reminderSlot(user: UserState, now: number): { date: string; expiresAt: number } | null {
    if (!user.reminders.enabled) return null;
    const local = dateParts(now, user.reminders.timeZone);
    const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const difference = toMinutes(local.time) - toMinutes(user.reminders.time);
    const delay = (difference + 1440) % 1440;
    if (delay >= 10) return null;
    const date = difference < 0
      ? new Date(Date.parse(`${local.date}T12:00:00Z`) - DAY).toISOString().slice(0, 10)
      : local.date;
    if (user.reminders.lastSentDate === date) return null;
    return { date, expiresAt: now + (10 - delay) * 60_000 - now % 60_000 };
  }
  private needsMaintenance(user: UserState, now: number): boolean {
    if (user.blocked) return false;
    const session = user.session;
    return user.outbox.length > 0 || Boolean(session && session.kind === 'exam' && session.endedAt === null &&
      session.deadlineAt !== null && now >= session.deadlineAt) || this.reminderSlot(user, now) !== null;
  }
  private async maintainUser(userId: number, now: number): Promise<PendingDelivery[]> {
    return this.store.update(key(userId), raw => {
      const user = this.registeredUser(raw, key(userId));
      if (!user) return { state: raw, result: [] as PendingDelivery[] };
      this.pruneReminders(user, now);
      if (user.blocked) return { state: user, result: [] as PendingDelivery[] };
      if (this.expireExam(user, now)) this.enqueue(user, `timeout_${user.session!.id}`, this.renderSession(user), now);
      const slot = this.reminderSlot(user, now);
      if (slot) {
        user.reminders.lastSentDate = slot.date;
        this.enqueue(user, `reminder_${slot.date}`, { text: 'Есть 15 минут на армянский? Продолжим занятие или повторим слова.',
          buttons: [[button('Начать занятие', 'menu:today')], [button('Выключить напоминания', 'settings:off')]] }, now, slot.expiresAt);
      }
      return { state: user, result: this.pending(user) };
    });
  }
  private pending(user: UserState): PendingDelivery[] {
    return user.outbox.filter(item => item.userId === user.userId && item.chatId === user.userId)
      .map(({ id, userId, chatId, view }) => ({ id, userId, chatId, view }));
  }
  private pruneReminders(user: UserState, now: number): void {
    user.outbox = user.outbox.filter(item => !item.id.startsWith('reminder_') ||
      (user.reminders.enabled && item.expiresAt != null && now < item.expiresAt));
  }
  private async registeredUsers(): Promise<UserState[]> {
    const users: UserState[] = [];
    let afterKey: string | undefined;
    do {
      const page = await this.store.listPage('u_', { afterKey, limit: 100 });
      for (const record of page.records) {
        if (record.state === null) continue;
        const user = parseState(record.state);
        if (Number.isSafeInteger(user.userId) && user.userId > 0 && user.chatId === user.userId &&
          record.key === key(user.userId) && Number.isFinite(user.updatedAt)) {
          // Administrative reports need counters, not every saved lesson and delivery payload.
          users.push({ ...user, session: null, outbox: [], processedEvents: [] });
        }
      }
      if (page.nextCursor === null) return users;
      if (afterKey !== undefined && page.nextCursor <= afterKey) throw new Error('Invalid administrator page cursor');
      afterKey = page.nextCursor;
    } while (true);
  }
  private adminView(user: UserState, action: string, records: UserState[], now: number): MessageView {
    const users = [...records.filter(record => record.userId !== user.userId), user];
    const navigation = [[button('Статистика', 'admin:stats'), button('Участники', 'admin:users:0')],
      [button('Выбор вариантов', 'admin:questions:0'), button('Ошибки в заданиях', 'admin:reports:0')], menuButton];
    if (action.startsWith('admin:questions:')) {
      const questions = aggregateUsage(users, now).questions;
      if (!questions.length) return { text: 'Ответов на вопросы с начала сбора ещё нет.', buttons: navigation };
      const requested = Number(action.split(':')[2]);
      const page = Number.isSafeInteger(requested) ? Math.max(0, Math.min(requested, questions.length - 1)) : 0;
      const question = questions[page]!;
      const options = Object.values(question.options).sort((a, b) => b.count - a.count)
        .map(option => `${option.correct ? '✓' : '•'} ${option.text}: ${option.count}/${question.answers}`);
      const pages = [];
      if (page > 0) pages.push(button('← Назад', `admin:questions:${page - 1}`));
      if (page + 1 < questions.length) pages.push(button('Дальше →', `admin:questions:${page + 1}`));
      return { text: `Выбор вариантов · ${page + 1}/${questions.length}\n${question.id}\nВерсия: ${question.version}\n\n${question.prompt}\n\nОтветов: ${question.answers}; правильно: ${question.correct}; с подсказкой: ${question.hintedAnswers}\n${options.join('\n')}\n\nПорядок кнопок не влияет на счётчики. Данные относятся к сохранённой версии вопроса с начала её сбора; старые записи могут вытесняться.`,
        buttons: [...(pages.length ? [pages] : []), ...navigation] };
    }
    if (action.startsWith('admin:reports:')) {
      const rendered = renderReportPage(collectReports(users), Number(action.split(':')[2]));
      const pages = [];
      if (rendered.page > 0) pages.push(button('← Назад', `admin:reports:${rendered.page - 1}`));
      if (rendered.page + 1 < rendered.pages) pages.push(button('Дальше →', `admin:reports:${rendered.page + 1}`));
      return { text: rendered.text, buttons: [...(pages.length ? [pages] : []), ...navigation] };
    }
    if (action.startsWith('admin:users:')) {
      const pages = Math.max(1, Math.ceil(users.length / 5)), requested = Number(action.split(':')[2]);
      const page = Number.isSafeInteger(requested) ? Math.max(0, Math.min(requested, pages - 1)) : 0;
      const lessons = examLessons(this.course);
      const lines = users.sort((a, b) => b.updatedAt - a.updatedAt).slice(page * 5, (page + 1) * 5).map(record => {
        const topics = topicProgress(this.course, record.questionProgress ?? {}, now);
        return `ID ${record.userId}\nУроки маршрута: ${lessons.filter(lesson => record.completedLessons.includes(lesson.id)).length}/${lessons.length}; слов в работе: ${Object.keys(record.cards).length}\nВопросы освоены: ${topics.reduce((sum, topic) => sum + topic.mastered, 0)}/${this.course.questions.length}; повторить: ${topics.reduce((sum, topic) => sum + topic.due, 0)}\nПоследняя активность: ${new Date(record.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      });
      const pageButtons = [];
      if (page > 0) pageButtons.push(button('← Назад', `admin:users:${page - 1}`));
      if (page + 1 < pages) pageButtons.push(button('Дальше →', `admin:users:${page + 1}`));
      return { text: `Участники · ${page + 1}/${pages}\n\n${lines.join('\n\n')}`, buttons: [...(pageButtons.length ? [pageButtons] : []), ...navigation] };
    }
    return { text: renderStats(aggregateUsage(users, now)), buttons: navigation };
  }
  private feedbackPrompt(user: UserState, now: number): MessageView {
    const pending = pendingFeedback(user.feedback, now);
    if (!pending) return { text: 'Сообщение об ошибке устарело. Нажмите «Ошибка в задании» ещё раз.', buttons: [menuButton] };
    const prefix = `feedback:${pending.token}`;
    const cancel = [button('Отмена', `${prefix}:cancel`)];
    if (!pending.category) return { text: 'Что не так с заданием? Выберите тип проблемы.', buttons: [
      ...Object.entries(FEEDBACK_CATEGORY_LABELS).map(([category, label]) => [button(label, `${prefix}:category:${category}`)]), cancel] };
    const timer = user.session?.kind === 'exam' && user.session.endedAt === null ? '\nТаймер пробного теста продолжает идти.' : '';
    return { text: `Напишите, что стоит исправить (до 1000 символов), или отправьте сообщение без описания. Его увидит владелец бота.${timer}`,
      buttons: [[button('Отправить без описания', `${prefix}:submit`)], cancel] };
  }
  private routeFeedback(user: UserState, event: BotEvent, now: number): MessageView | undefined {
    const action = event.action ?? '', text = inputText(event.text);
    if (text.startsWith('/')) {
      if (user.feedback?.pending) user.feedback = cancelFeedback(user.feedback);
      if (text.split('@')[0] === '/cancel') return { text: 'Сообщение об ошибке отменено.', buttons: [[button('Продолжить занятие', 'menu:continue')], menuButton] };
      return undefined;
    }
    if (action.startsWith('report:')) {
      const [, sid, indexText] = action.split(':'), index = Number(indexText), session = user.session;
      const step = session && session.id === sid && Number.isSafeInteger(index) && index >= 0 ? session.steps[index] : undefined;
      if (!step || !session) return { text: 'Это задание уже устарело. Откройте текущее занятие.', buttons: [[button('Продолжить', 'menu:continue')], menuButton] };
      user.feedback = beginFeedback(user.feedback, {
        kind: step.kind, id: step.kind === 'word' ? step.word.id : step.question.id, contentVersion: session.contentVersion,
        prompt: step.kind === 'word' ? `Как переводится «${step.word.hy}»?` : step.question.promptHy,
        options: step.kind === 'word' ? step.choices : step.question.options.map(option => option.hy),
      }, now, event.eventId);
      return this.feedbackPrompt(user, now);
    }
    const pending = pendingFeedback(user.feedback, now);
    if (action.startsWith('feedback:')) {
      const [, token, verb, category] = action.split(':');
      if (!pending || pending.token !== token) return { text: 'Эти кнопки сообщения об ошибке устарели. Откройте форму заново.', buttons: [[button('Продолжить занятие', 'menu:continue')], menuButton] };
      if (verb === 'cancel') {
        user.feedback = cancelFeedback(user.feedback, token);
        return { text: 'Сообщение об ошибке отменено.', buttons: [[button('Продолжить занятие', 'menu:continue')], menuButton] };
      }
      if (verb === 'category' && category && Object.hasOwn(FEEDBACK_CATEGORY_LABELS, category)) {
        user.feedback = chooseFeedbackCategory(user.feedback, category, now, token);
        return this.feedbackPrompt(user, now);
      }
      if (verb !== 'submit' || !pending.category) return this.feedbackPrompt(user, now);
      user.feedback = submitFeedback(user.feedback, undefined, now, event.eventId, token).state;
    } else if (action) {
      if (user.feedback?.pending) user.feedback = cancelFeedback(user.feedback);
      return undefined;
    } else if (pending && text) {
      if (!pending.category) return this.feedbackPrompt(user, now);
      if (text.length > 1000) return { text: 'Описание слишком длинное. Сократите его до 1000 символов.', buttons: [[button('Отмена', `feedback:${pending.token}:cancel`)]] };
      user.feedback = submitFeedback(user.feedback, text, now, event.eventId, pending.token).state;
    } else return undefined;
    return { text: 'Сообщение об ошибке сохранено. Владелец сможет посмотреть задание и описание.', buttons: [[button('Продолжить занятие', 'menu:continue')], menuButton] };
  }
  private enqueue(user: UserState, id: string, view: MessageView, now: number, expiresAt: number | null = null): void {
    // Keeping the most recent views bounds the document if Telegram is unreachable.
    user.outbox = user.outbox.filter(x => x.id !== id).slice(-(MAX_OUTBOX - 1));
    user.outbox.push({ id, userId: user.userId, chatId: user.chatId, view, createdAt: now, leaseUntil: 0, expiresAt });
  }
  private route(user: UserState, event: BotEvent, now: number, users?: UserState[]): MessageView {
    const text = inputText(event.text);
    const command = text.split('@')[0];
    const adminAction = event.action?.startsWith('admin:') ? event.action
      : command === '/stats' ? 'admin:stats' : command === '/reports' ? 'admin:reports:0' : undefined;
    const feedbackView = this.routeFeedback(user, event, now);
    if (feedbackView) return feedbackView;
    if (adminAction) return this.admins.has(user.userId) && users
      ? this.adminView(user, adminAction, users, now)
      : { text: 'Эта команда доступна только администратору.', buttons: [menuButton] };
    if (text.startsWith('/remind ')) return this.setReminder(user, text, now);
    if (text === '/privacy') return { text: 'Бот хранит ваш Telegram ID, настройки, учебный прогресс и результаты. Дневная статистика показывается за 90 дней; более старые счётчики удаляются при следующем обновлении записи. Детализация выбора ответов ограничена объёмом и максимум 200 версиями вопросов, старые записи могут вытесняться. Отправленные через «Ошибка в задании» описания видит владелец: хранятся последние 20 сообщений каждого пользователя. Остальные тексты сообщений не сохраняются как переписка. Данные не публикуются в GitHub. /reset очищает учебный прогресс; статистика использования и отправленные сообщения об ошибках сохраняются. Для полного удаления данных обратитесь к владельцу бота.', buttons: [menuButton] };
    if (text === '/reset') return { text: 'Удалить ваш учебный прогресс, результаты и настройки напоминаний? Статистика использования и отправленные сообщения об ошибках сохранятся. Это действие нельзя отменить.', buttons: [[button('Сбросить мой прогресс', 'reset:confirm')], menuButton] };
    if (text === '/admin' && this.admins.has(user.userId)) return { text: `${this.accessMode === 'public' ? 'Доступ открыт всем пользователям в личном чате.' : `Доступ разрешён ${this.allowed.size} участникам.`}\nВерсия курса: ${this.course.version}\nВопросов: ${this.course.questions.length}; слов: ${this.course.vocabulary.length}; уроков: ${this.course.lessons.length}.\n/stats — статистика и участники\n/reports — сообщения об ошибках\nРежим задаётся в ACCESS_MODE; администраторы — в ADMIN_USER_IDS.${this.accessMode === 'private' ? '\nСписок участников задаётся в ALLOWED_USER_IDS.' : ''}`, buttons: [[button('Статистика', 'admin:stats'), button('Ошибки в заданиях', 'admin:reports:0')], menuButton] };
    const action = event.action ?? ({ '/start': 'menu:home', '/menu': 'menu:home', '/today': 'menu:today', '/path': 'menu:path', '/progress': 'menu:progress', '/help': 'menu:help', '/settings': 'menu:settings' } as Record<string, string>)[text.split('@')[0] ?? ''] ?? '';
    if (action === 'reset:confirm') {
      const fresh = initial(user.userId, user.chatId, now);
      fresh.createdAt = user.createdAt;
      fresh.processedEvents = user.processedEvents;
      fresh.analytics = user.analytics;
      if (user.feedback) fresh.feedback = cancelFeedback(user.feedback);
      Object.assign(user, fresh);
      return { text: 'Прогресс сброшен. Можно начать заново.', buttons: [[button('Начать', 'menu:today')], menuButton] };
    }
    if (action.startsWith('menu:')) {
      const name = action.slice(5);
      if (name === 'home') return this.menu(user);
      if (name === 'path') return this.examPath(user, now);
      if (name === 'progress') return this.progress(user, now);
      if (name === 'topics') return this.topics(user, now);
      if (name === 'settings') return this.settings(user);
      if (name === 'help') return { text: `Курс помогает понимать армянские вопросы и повторять нужные слова. Начните с «Подготовка к экзамену». В тренировке можно разобрать ключевые слова или открыть перевод; в пробном тесте подсказок нет. О неточности сообщите кнопкой «Ошибка в задании».\n\n${this.course.noticeRu}\n\n/start — меню\n/path — маршрут к экзамену\n/progress — прогресс\n/remind 19:00 Asia/Yerevan — напоминания\n/cancel — отменить сообщение об ошибке\n/privacy — данные\n/reset — сброс\n\nТест в учебном боте не заменяет официальную процедуру.`, buttons: [menuButton] };
      if (name === 'continue' && user.session) return this.renderSession(user);
      if (name === 'exam') return { text: 'Пробный тест: 33 вопроса на армянском, по 4 варианта ответа, 60 минут, проходной результат 17. Перевод и подсказки выключены.\n\nЭто авторские тренировочные вопросы, а не подтверждённый текущий официальный банк. Начало теста заменит незавершённое занятие.', buttons: [[button('Начать тест', 'start:exam')], menuButton] };
      if (name === 'lessons' || name.startsWith('lessons:')) return this.lessons(user, name.slice('lessons:'.length));
      if (name === 'path_lessons' || name.startsWith('path_lessons:')) return this.lessons(user, name.slice('path_lessons:'.length), true);
      if (name === 'today' && user.session && user.session.endedAt === null) return this.renderSession(user);
      if (name === 'today') return this.startToday(user, event.eventId, now);
      if (name === 'path_next') return this.startToday(user, event.eventId, now);
      if (name === 'exam_words') return this.startWords(user, event.eventId, now, false, undefined, true);
      if (name === 'question_review') return this.startPractice(user, event.eventId, now, true);
      if (name === 'words' || name === 'review') return this.startWords(user, event.eventId, now, name === 'review');
      if (name === 'nouns' || name === 'verbs' || name === 'other') return this.startWords(user, event.eventId, now, false, name);
      if (name === 'practice') return this.startPractice(user, event.eventId, now);
    }
    if (action === 'settings:on') { user.reminders.enabled = true; return this.settings(user); }
    if (action === 'settings:off') { user.reminders.enabled = false; return this.settings(user); }
    if (action === 'settings:yerevan') { user.reminders.timeZone = 'Asia/Yerevan'; return this.settings(user); }
    if (action === 'settings:qyzylorda') { user.reminders.timeZone = 'Asia/Qyzylorda'; return this.settings(user); }
    if (action === 'start:exam') {
      if (this.course.questions.length < 33) return { text: 'Для пробного теста нужно не менее 33 проверенных вопросов. Пока доступна тренировка.', buttons: [[button('Тренировка', 'menu:practice')], menuButton] };
      return this.begin(user, 'exam', 'Пробный тест', shuffled(this.course.questions, event.eventId).slice(0, 33).map(question => ({ kind: 'question', question })), now, event.eventId);
    }
    if (action.startsWith('lesson:')) {
      const lesson = this.course.lessons.find(x => x.id === action.slice(7));
      if (lesson) return this.beginLesson(user, lesson.id, event.eventId, now);
    }
    if (action.startsWith('mistakes:')) return this.mistakes(user, action);
    const parts = action.split(':'), session = user.session;
    if (['answer', 'hint', 'reading', 'next'].includes(parts[0] ?? '')) {
      if (!session || session.endedAt !== null || parts[1] !== session.id || Number(parts[2]) !== session.index) {
        return { text: 'Эта карточка уже завершена или устарела. Откройте текущее занятие.', buttons: [[button('Продолжить', 'menu:continue')], menuButton] };
      }
      if (parts[0] === 'hint') {
        if (session.kind !== 'exam' && !session.feedback && !session.hints.includes(session.index)) {
          if (!session.readingHints?.includes(session.index)) user.analytics = recordUsage(user.analytics, { kind: 'hint' }, now);
          session.hints.push(session.index);
        }
        return this.renderSession(user);
      }
      if (parts[0] === 'reading') {
        const step = session.steps[session.index]!;
        if (session.kind !== 'exam' && !session.feedback && step.kind === 'question' && step.question.readingHelp?.length) {
          session.readingHints ??= [];
          if (!session.readingHints.includes(session.index)) {
            if (!session.hints.includes(session.index)) user.analytics = recordUsage(user.analytics, { kind: 'hint' }, now);
            session.readingHints.push(session.index);
          }
        }
        return this.renderSession(user);
      }
      if (parts[0] === 'next') {
        if (session.feedback) { session.index++; session.feedback = false; if (session.index >= session.steps.length) this.finish(user, now, false); }
        return this.renderSession(user);
      }
      const selected = Number(parts[3]);
      const step = session.steps[session.index]!;
      const optionCount = step.kind === 'word' ? step.choices.length : step.question.options.length;
      if (!Number.isInteger(selected) || selected < 0 || selected >= optionCount || session.feedback) return this.renderSession(user);
      this.answer(user, selected, now);
      return this.renderSession(user);
    }
    return { text: 'Используйте кнопки под заданием или /start для меню. Напоминания: /remind 19:00 Asia/Yerevan.', buttons: [menuButton] };
  }
  private menu(user: UserState): MessageView {
    const rows = [[button('Подготовка к экзамену', 'menu:path')], [button('Сегодня · 15 минут', 'menu:today')], [button('Слова', 'menu:words'), button('Повторить', 'menu:review')],
      [button('Уроки', 'menu:lessons'), button('Тренировка', 'menu:practice')], [button('Пробный тест', 'menu:exam')],
      [button('Прогресс', 'menu:progress'), button('Настройки', 'menu:settings')], [button('О курсе', 'menu:help')]];
    const categories = (Object.keys(CATEGORY_LABELS) as VocabularyCategory[])
      .filter(category => this.course.vocabulary.some(word => word.category === category))
      .map(category => button(CATEGORY_LABELS[category], `menu:${category}`));
    if (categories.length) rows.splice(2, 0, categories);
    if (this.admins.has(user.userId)) rows.push([button('Статистика', 'admin:stats'), button('Ошибки в заданиях', 'admin:reports:0')]);
    if (user.session && user.session.endedAt === null) rows.unshift([button('Продолжить занятие', 'menu:continue')]);
    return { text: `Армянский для теста на гражданство\n\nЧитаем вопросы, учим лексику и разбираем ответы.\n\n${this.course.noticeRu}`, buttons: rows };
  }
  private lessons(user: UserState, requestedPage: string, examOnly = false): MessageView {
    const lessons = examOnly ? examLessons(this.course) : this.course.lessons;
    const prefix = examOnly ? 'menu:path_lessons' : 'menu:lessons';
    const pages = Math.max(1, Math.ceil(lessons.length / LESSONS_PER_PAGE));
    const parsed = Number(requestedPage);
    const page = Number.isSafeInteger(parsed) ? Math.max(0, Math.min(parsed, pages - 1)) : 0;
    const rows = lessons.slice(page * LESSONS_PER_PAGE, (page + 1) * LESSONS_PER_PAGE)
      .map(lesson => [button(`${user.completedLessons.includes(lesson.id) ? '✓ ' : ''}${lesson.titleRu}`, `lesson:${lesson.id}`)]);
    const navigation = [];
    if (page > 0) navigation.push(button('← Назад', `${prefix}:${page - 1}`));
    if (page + 1 < pages) navigation.push(button('Дальше →', `${prefix}:${page + 1}`));
    if (navigation.length) rows.push(navigation);
    rows.push(menuButton);
    return { text: `${examOnly ? 'Уроки к экзамену' : 'Уроки'} · страница ${page + 1}/${pages}\n\nВыберите короткое занятие. Отметка ✓ означает, что урок уже пройден.`, buttons: rows };
  }
  private examPath(user: UserState, now: number): MessageView {
    const lessons = examLessons(this.course), words = examVocabulary(this.course);
    const completed = lessons.filter(lesson => user.completedLessons.includes(lesson.id)).length;
    const progress = topicProgress(this.course, user.questionProgress ?? {}, now);
    const due = progress.reduce((sum, topic) => sum + topic.due, 0);
    const rows = [[button('Следующий урок', 'menu:path_next')], [button('Лексика экзамена', 'menu:exam_words')],
      [button(`Повторить вопросы (${due})`, 'menu:question_review')], [button('Уроки маршрута', 'menu:path_lessons')],
      [button('Прогресс по темам', 'menu:topics'), button('Пробный тест', 'menu:exam')], menuButton];
    if (user.session?.endedAt === null) rows.unshift([button('Продолжить занятие', 'menu:continue')]);
    return { text: `Подготовка к экзамену\n\nУроки маршрута: ${completed}/${lessons.length}\nЛексика: ${words.filter(word => user.cards[word.id]).length}/${words.length}\nВопросов к повторению: ${due}\n\nСначала лексика, затем чтение вопроса и выбор ответа. Кнопка «Разобрать вопрос» объяснит важные армянские конструкции. Ответы с помощью не считаются самостоятельным освоением.\n\nОбщий словарь доступен через «Слова» в главном меню.`, buttons: rows };
  }
  private topics(user: UserState, now: number): MessageView {
    const rows = topicProgress(this.course, user.questionProgress ?? {}, now);
    const lines = rows.map(topic => `${topic.topic}: освоено ${topic.mastered}/${topic.total}, встречалось ${topic.seen}, повторить ${topic.due}`);
    return { text: `Прогресс по темам\n\n${lines.join('\n')}\n\nОсвоение — самостоятельные правильные ответы в разные дни по плану повторений. Это прогресс по учебному банку, а не прогноз сдачи экзамена.`,
      buttons: [[button('Повторить вопросы', 'menu:question_review')], [button('К экзамену', 'menu:path')], menuButton] };
  }
  private progress(user: UserState, now: number): MessageView {
    const cards = Object.values(user.cards);
    const topics = topicProgress(this.course, user.questionProgress ?? {}, now);
    const mastered = topics.reduce((sum, topic) => sum + topic.mastered, 0);
    const dueQuestions = topics.reduce((sum, topic) => sum + topic.due, 0);
    const exams = user.exams.slice(-5).reverse().map(x => `${new Date(x.at).toISOString().slice(0, 10)}: ${x.score}/${x.total}${x.timedOut ? ' (время истекло)' : ''}`);
    return { text: `Ваш прогресс\n\nУроки: ${user.completedLessons.length}/${this.course.lessons.length}\nСлова в работе: ${cards.length}/${this.course.vocabulary.length}\nСлова на интервале 7+ дней: ${cards.filter(x => x.level >= 3).length}\nК повторению: ${cards.filter(x => x.dueAt <= now).length}\nВопросы освоены: ${mastered}/${this.course.questions.length}\nВопросы к повторению: ${dueQuestions}\nОтветы без подсказок: ${user.correct}/${user.attempts}\n\nПоследние пробные тесты:\n${exams.length ? exams.join('\n') : 'Ещё не проходили.'}`, buttons: [[button('Повторить слова', 'menu:review'), button('Повторить вопросы', 'menu:question_review')], [button('По темам', 'menu:topics')], menuButton] };
  }
  private settings(user: UserState): MessageView {
    return { text: `Напоминания: ${user.reminders.enabled ? 'включены' : 'выключены'}\nВремя: ${user.reminders.time}\nЧасовой пояс: ${user.reminders.timeZone}\n\nИзменить время и пояс:\n/remind 19:00 Asia/Yerevan\n/remind 20:30 Asia/Qyzylorda\n\nНапоминания приходят только при работающем боте.`, buttons: [[button(user.reminders.enabled ? 'Выключить' : 'Включить', user.reminders.enabled ? 'settings:off' : 'settings:on')], [button('Ереван', 'settings:yerevan'), button('Кызылорда', 'settings:qyzylorda')], menuButton] };
  }
  private setReminder(user: UserState, text: string, now: number): MessageView {
    const match = /^\/remind ([01]\d|2[0-3]):([0-5]\d) ([A-Za-z_]+\/[A-Za-z_+\-/]+)$/.exec(text);
    if (!match || !validTimeZone(match[3]!)) return { text: 'Формат: /remind 19:00 Asia/Yerevan. Укажите существующий часовой пояс и время от 00:00 до 23:59.', buttons: [menuButton] };
    user.reminders.time = `${match[1]}:${match[2]}`; user.reminders.timeZone = match[3]!; user.reminders.enabled = true;
    // Do not reset lastSentDate on settings changes: at most one reminder per local calendar date.
    user.updatedAt = now;
    return this.settings(user);
  }
  private wordStep(word: Vocabulary, seed: string): Step {
    const distractors = selectWordDistractors(word, this.course, shuffled(this.course.vocabulary, seed + word.id));
    const choices = shuffled([word.ru, ...distractors], seed + word.id);
    return { kind: 'word', word, choices, correctIndex: choices.indexOf(word.ru) };
  }
  private startToday(user: UserState, seed: string, now: number): MessageView {
    const due = examVocabulary(this.course).filter(x => user.cards[x.id] && user.cards[x.id]!.dueAt <= now).slice(0, 5);
    const questions = selectPracticeQuestions(this.course.questions, user.questionProgress ?? {}, user.questionMistakes,
      { seed, now, dueOnly: true, limit: 3 });
    const lesson = examLessons(this.course).find(x => !user.completedLessons.includes(x.id));
    if (!lesson) {
      if (due.length || questions.length) return this.begin(user, 'review', 'Повторение к экзамену',
        [...due.map(word => this.wordStep(word, seed)), ...questions.map(question => ({ kind: 'question' as const, question }))], now, seed);
      return this.startPractice(user, seed, now);
    }
    return this.beginLesson(user, lesson.id, seed, now, due, questions);
  }
  private beginLesson(user: UserState, id: string, seed: string, now: number, due: Vocabulary[] = [], reviews: Question[] = []): MessageView {
    const lesson = this.course.lessons.find(x => x.id === id)!;
    const words = [...due, ...lesson.vocabularyIds.map(x => this.course.vocabulary.find(y => y.id === x)!)];
    const steps: Step[] = [...new Map(words.map(x => [x.id, x])).values()].map(x => this.wordStep(x, seed));
    steps.push(...reviews.filter(question => !lesson.questionIds.includes(question.id)).map(question => ({ kind: 'question' as const, question })));
    steps.push(...lesson.questionIds.map(id => ({ kind: 'question' as const, question: this.course.questions.find(x => x.id === id)! })));
    return this.begin(user, 'lesson', `${lesson.titleRu}\n${lesson.introRu}`, steps, now, seed, lesson.id);
  }
  private startWords(user: UserState, seed: string, now: number, dueOnly: boolean, category?: VocabularyCategory, examOnly = false): MessageView {
    const vocabulary = examOnly ? examVocabulary(this.course) : category ? this.course.vocabulary.filter(word => word.category === category) : this.course.vocabulary;
    const due = vocabulary.filter(x => user.cards[x.id] && user.cards[x.id]!.dueAt <= now);
    const words = dueOnly ? due : [...due, ...vocabulary.filter(x => !user.cards[x.id])];
    if (words.length === 0) {
      const text = category
        ? (vocabulary.length ? `В разделе «${CATEGORY_LABELS[category]}» все слова уже в работе. Повторений на сейчас нет. Можно выбрать урок или другой раздел.`
          : `В разделе «${CATEGORY_LABELS[category]}» пока нет слов. Выберите другой раздел или урок.`)
        : (dueOnly ? 'На сейчас повторений нет. Можно перейти к следующему уроку.' : 'Все слова уже в работе. Для практики откройте урок или повторения.');
      return { text, buttons: [[button('Уроки', 'menu:lessons')], menuButton] };
    }
    const title = examOnly ? 'Лексика экзамена' : category ? CATEGORY_LABELS[category] : (dueOnly ? 'Повторение слов' : 'Общий словарь');
    return this.begin(user, 'review', title, words.slice(0, 10).map(x => this.wordStep(x, seed)), now, seed);
  }
  private startPractice(user: UserState, seed: string, now: number, dueOnly = false): MessageView {
    const questions = selectPracticeQuestions(this.course.questions, user.questionProgress ?? {}, user.questionMistakes,
      { seed, now, limit: 10, dueOnly, allowEarly: !dueOnly });
    if (!questions.length) return { text: 'Вопросов к повторению сейчас нет. Можно начать новую тренировку или продолжить маршрут.',
      buttons: [[button('Тренировка', 'menu:practice'), button('К экзамену', 'menu:path')], menuButton] };
    return this.begin(user, 'practice', dueOnly ? 'Повторение вопросов' : 'Тренировка вопросов', questions.map(question => ({ kind: 'question', question })), now, seed);
  }
  private begin(user: UserState, kind: StudySession['kind'], title: string, steps: Step[], now: number, seed: string, lessonId: string | null = null): MessageView {
    const snapshot = structuredClone(steps);
    for (const step of snapshot) {
      if (step.kind !== 'question') continue;
      const question = step.question;
      const correct = question.options[question.correctIndex]!;
      question.options = shuffled(question.options, `${user.userId}:${seed}:${now}:${question.id}`);
      question.correctIndex = question.options.indexOf(correct);
    }
    user.session = { id: createHash('sha256').update(`${user.userId}:${seed}:${now}`).digest('hex').slice(0, 12), kind, title, lessonId,
      contentVersion: this.course.version, steps: snapshot, index: 0, answers: [], hints: [], readingHints: [], feedback: false,
      startedAt: now, deadlineAt: kind === 'exam' ? now + 3600_000 : null, endedAt: null };
    user.analytics = recordUsage(user.analytics, { kind: 'start' }, now);
    return this.renderSession(user);
  }
  private answer(user: UserState, selected: number, now: number): void {
    const session = user.session!, step = session.steps[session.index]!;
    if (session.answers.some(x => x.step === session.index)) return;
    const correctIndex = step.kind === 'word' ? step.correctIndex : step.question.correctIndex;
    const correct = selected === correctIndex, hinted = session.hints.includes(session.index) || Boolean(session.readingHints?.includes(session.index));
    session.answers.push({ step: session.index, selected, correct, hinted });
    user.attempts++; if (correct && !hinted) user.correct++;
    user.analytics = recordUsage(user.analytics, { kind: 'answer', selected, correct, hinted,
      ...(step.kind === 'question' ? { question: { id: step.question.id, version: session.contentVersion,
        prompt: step.question.promptRu, options: step.question.options.map(option => option.ru), correctIndex } } : {}),
    }, now);
    if (step.kind === 'word') {
      const card = user.cards[step.word.id] ?? { level: 0, dueAt: now, seen: 0, mistakes: 0 };
      card.seen++;
      if (correct && !hinted && card.dueAt <= now) { const days = INTERVALS[Math.min(card.level, 4)]!; card.level = Math.min(card.level + 1, 5); card.dueAt = now + days * DAY; }
      else if (correct && !hinted) { /* Extra practice does not advance a card before its due date. */ }
      else { card.level = 0; card.dueAt = now + 10 * 60_000; if (!correct) card.mistakes++; }
      user.cards[step.word.id] = card;
    } else {
      user.questionProgress = updateQuestionProgress(user.questionProgress ?? {}, step.question.id, { correct, hinted, now });
      if (!correct) user.questionMistakes[step.question.id] = (user.questionMistakes[step.question.id] ?? 0) + 1;
      else if (!hinted) user.questionMistakes[step.question.id] = Math.max(0, (user.questionMistakes[step.question.id] ?? 0) - 1);
    }
    if (session.kind === 'exam') { session.index++; if (session.index >= session.steps.length) this.finish(user, now, false); }
    else session.feedback = true;
  }
  private finish(user: UserState, now: number, timedOut: boolean): void {
    const session = user.session!;
    if (session.endedAt !== null) return;
    session.endedAt = now;
    user.analytics = recordUsage(user.analytics, { kind: 'complete' }, now);
    if (session.kind === 'exam') {
      const score = session.answers.filter(x => x.correct).length;
      user.exams.push({ at: now, score, total: session.steps.length, timedOut, version: session.contentVersion });
      user.exams = user.exams.slice(-30);
      user.analytics = recordUsage(user.analytics, { kind: 'exam', score, total: session.steps.length, passed: score >= 17 }, now);
    }
    if (session.lessonId && !user.completedLessons.includes(session.lessonId)) user.completedLessons.push(session.lessonId);
  }
  private expireExam(user: UserState, now: number): boolean {
    const session = user.session;
    if (!session || session.kind !== 'exam' || session.endedAt !== null || session.deadlineAt === null || now < session.deadlineAt) return false;
    this.finish(user, now, true); return true;
  }
  private renderSession(user: UserState): MessageView {
    const session = user.session;
    if (!session) return this.menu(user);
    if (session.endedAt !== null) {
      const score = session.answers.filter(x => x.correct && !x.hinted).length;
      const exam = session.kind === 'exam';
      const outcome = exam ? `\n${score >= 17 ? 'Проходной результат тренировочного теста достигнут.' : 'Проходной результат пока не достигнут.'}\nПорог: 17 из 33.` : '\nОшибки и задания с подсказками вернутся в повторение.';
      return { text: `${exam ? 'Пробный тест завершён' : 'Занятие завершено'}\n\nСамостоятельно правильно: ${score}/${session.steps.length}.${outcome}\n\nЭто результат тренировки, не оценка официального экзамена.`, buttons: [[button('Разобрать ошибки', `mistakes:${session.id}:0`)], [button('Следующее занятие', 'menu:today')], menuButton] };
    }
    const step = session.steps[session.index]!;
    const prefix = `${session.title}\n\n${session.index + 1}/${session.steps.length}`;
    const timer = session.deadlineAt ? `\nОкончание: ${new Intl.DateTimeFormat('ru-RU', { timeZone: user.reminders.timeZone, hour: '2-digit', minute: '2-digit' }).format(session.deadlineAt)} (${user.reminders.timeZone}). 60 минут с начала теста.` : '';
    const prompt = step.kind === 'word' ? `Как переводится «${step.word.hy}»?` : step.question.promptHy;
    const options = step.kind === 'word' ? step.choices : step.question.options.map(x => x.hy);
    let text = `${prefix}${timer}\n\n${prompt}\n\n${options.map((value, i) => `${i + 1}. ${value}`).join('\n')}`;
    const isHinted = session.hints.includes(session.index);
    const isReading = Boolean(session.readingHints?.includes(session.index));
    if (isReading && session.kind !== 'exam' && step.kind === 'question' && step.question.readingHelp?.length) {
      text += `\n\nРазбор вопроса:\n${step.question.readingHelp.map(item => `${item.hy} — ${item.ru}. ${item.noteRu}`).join('\n')}`;
    }
    if (isHinted && session.kind !== 'exam') {
      text += step.kind === 'word' ? `\n\nПеревод: ${step.word.ru}` : `\n\nПеревод вопроса: ${step.question.promptRu}\n${step.question.options.map((x, i) => `${i + 1}. ${x.ru}`).join('\n')}`;
    }
    if (session.feedback) {
      const answer = session.answers.find(x => x.step === session.index)!;
      text += `\n\n${answer.correct ? 'Верно.' : 'Пока неверно.'}${answer.hinted ? ' Ответ с подсказкой не считается освоением.' : ''}\n`;
      text += step.kind === 'word' ? `${step.word.hy} — ${step.word.ru}${step.word.exampleHy ? `\n${step.word.exampleHy}\n${step.word.exampleRu ?? ''}` : ''}` : `${step.question.explanationRu}\nИсточник: ${step.question.source.article}\n${step.question.source.url}`;
      return { text, buttons: [[button('Дальше', `next:${session.id}:${session.index}`)], [button('Ошибка в задании', `report:${session.id}:${session.index}`)], menuButton] };
    }
    const rows = [options.map((_, i) => button(String(i + 1), `answer:${session.id}:${session.index}:${i}`))];
    if (session.kind !== 'exam' && !isReading && step.kind === 'question' && step.question.readingHelp?.length) {
      rows.push([button('Разобрать вопрос', `reading:${session.id}:${session.index}`)]);
    }
    if (session.kind !== 'exam' && !isHinted) rows.push([button(step.kind === 'word' ? 'Показать перевод' : 'Перевод вопроса', `hint:${session.id}:${session.index}`)]);
    rows.push([button('Ошибка в задании', `report:${session.id}:${session.index}`)]);
    rows.push(menuButton);
    return { text, buttons: rows };
  }
  private mistakes(user: UserState, action: string): MessageView {
    const [, sid, pageText] = action.split(':'), session = user.session;
    if (!session || session.id !== sid || session.endedAt === null) return { text: 'Разбор доступен после завершения текущего занятия.', buttons: [menuButton] };
    const wrong = session.steps.map((step, index) => ({ step, index, answer: session.answers.find(a => a.step === index) })).filter(x => !x.answer?.correct || x.answer.hinted);
    if (!wrong.length) return { text: 'Ошибок и ответов с подсказкой нет.', buttons: [menuButton] };
    const parsed = Number(pageText), page = Number.isInteger(parsed) ? Math.max(0, Math.min(parsed, wrong.length - 1)) : 0;
    const { step, answer, index } = wrong[page]!;
    let text = `Разбор ${page + 1}/${wrong.length}\n${answer ? (answer.hinted ? 'Была использована подсказка.' : 'Ответ был неверным.') : 'Ответ не дан.'}\n\n`;
    text += step.kind === 'word' ? `${step.word.hy} — ${step.word.ru}` : `${step.question.promptHy}\n${step.question.promptRu}\n\nПравильный ответ: ${step.question.options[step.question.correctIndex]!.hy}\n${step.question.explanationRu}\n\n${step.question.source.article}\n${step.question.source.url}`;
    const navigation = [];
    if (page > 0) navigation.push(button('Назад', `mistakes:${sid}:${page - 1}`));
    if (page + 1 < wrong.length) navigation.push(button('Дальше', `mistakes:${sid}:${page + 1}`));
    return { text, buttons: [...(navigation.length ? [navigation] : []), [button('Ошибка в задании', `report:${sid}:${index}`)], menuButton] };
  }
}
