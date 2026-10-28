import { createHash } from 'node:crypto';
import type { Course, Question, Vocabulary } from './course.js';
import type { StateStore } from './storage.js';

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
  startedAt: number; deadlineAt: number | null; endedAt: number | null;
}
interface CardProgress { level: number; dueAt: number; seen: number; mistakes: number }
interface DeliveryRecord extends PendingDelivery { leaseUntil: number; createdAt: number; expiresAt: number | null }
interface ExamResult { at: number; score: number; total: number; timedOut: boolean; version: string }
export interface UserState {
  schema: 1; userId: number; chatId: number; createdAt: number; updatedAt: number;
  session: StudySession | null; cards: Record<string, CardProgress>; questionMistakes: Record<string, number>;
  completedLessons: string[]; attempts: number; correct: number; exams: ExamResult[];
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
function initial(userId: number, chatId: number, now: number): UserState {
  return { schema: 1, userId, chatId, createdAt: now, updatedAt: now, session: null,
    cards: {}, questionMistakes: {}, completedLessons: [], attempts: 0, correct: 0, exams: [],
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
  constructor(options: { store: StateStore; course: Course; allowedUserIds: number[]; adminUserIds: number[] }) {
    this.store = options.store; this.course = options.course;
    this.allowed = new Set([...options.allowedUserIds, ...options.adminUserIds]);
    this.admins = new Set(options.adminUserIds);
  }
  async handle(event: BotEvent): Promise<PendingDelivery[]> {
    if (!Number.isSafeInteger(event.userId) || event.userId <= 0 || event.chatId !== event.userId) return [];
    if (!this.allowed.has(event.userId)) return [];
    const now = event.now ?? Date.now();
    if (!Number.isFinite(now) || !event.eventId || event.eventId.length > 100) throw new Error('Invalid event');
    return this.store.update(key(event.userId), raw => {
      const user = raw === null ? initial(event.userId, event.chatId, now) : parseState(raw);
      this.pruneReminders(user, now);
      if (user.processedEvents.includes(event.eventId)) return { state: user, result: this.pending(user) };
      user.updatedAt = now; user.blocked = false;
      let view: MessageView;
      if (this.expireExam(user, now)) {
        view = this.renderSession(user);
      } else {
        view = this.route(user, event, now);
      }
      this.pruneReminders(user, now);
      user.processedEvents.push(event.eventId);
      user.processedEvents = user.processedEvents.slice(-200);
      this.enqueue(user, `event_${event.eventId}`, view, now);
      return { state: user, result: this.pending(user) };
    });
  }
  async claim(userId: number, id: string): Promise<boolean> {
    if (!this.allowed.has(userId)) return false;
    return this.store.update(key(userId), raw => {
      if (raw === null) return { state: null, result: false };
      const user = parseState(raw), now = Date.now();
      this.pruneReminders(user, now);
      const item = user.outbox.find(x => x.id === id);
      if (user.blocked) return { state: user, result: false };
      if (!item || item.leaseUntil > now) return { state: user, result: false };
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
    // Access and small-group capacity are explicit; revoked IDs receive no deliveries.
    for (const userId of this.allowed) {
      const items = await this.store.update(key(userId), raw => {
        if (raw === null) return { state: null, result: [] as PendingDelivery[] };
        const user = parseState(raw);
        this.pruneReminders(user, now);
        if (user.blocked) return { state: user, result: [] as PendingDelivery[] };
        if (this.expireExam(user, now)) this.enqueue(user, `timeout_${user.session!.id}`, this.renderSession(user), now);
        if (user.reminders.enabled) {
          const local = dateParts(now, user.reminders.timeZone);
          const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
          const difference = toMinutes(local.time) - toMinutes(user.reminders.time);
          const delay = (difference + 1440) % 1440;
          const scheduledDate = difference < 0
            ? new Date(Date.parse(`${local.date}T12:00:00Z`) - DAY).toISOString().slice(0, 10)
            : local.date;
          // A ten-minute grace window covers the five-minute scheduler; do not backfill a missed day.
          if (delay < 10 && user.reminders.lastSentDate !== scheduledDate) {
            user.reminders.lastSentDate = scheduledDate;
            this.enqueue(user, `reminder_${scheduledDate}`, { text: 'Есть 15 минут на армянский? Продолжим занятие или повторим слова.',
              buttons: [[button('Начать занятие', 'menu:today')], [button('Выключить напоминания', 'settings:off')]] }, now,
              now + (10 - delay) * 60_000 - now % 60_000);
          }
        }
        return { state: user, result: this.pending(user) };
      });
      pending.push(...items);
    }
    return pending;
  }
  private pending(user: UserState): PendingDelivery[] {
    return user.outbox.map(({ id, userId, chatId, view }) => ({ id, userId, chatId, view }));
  }
  private pruneReminders(user: UserState, now: number): void {
    user.outbox = user.outbox.filter(item => !item.id.startsWith('reminder_') ||
      (user.reminders.enabled && item.expiresAt != null && now < item.expiresAt));
  }
  private enqueue(user: UserState, id: string, view: MessageView, now: number, expiresAt: number | null = null): void {
    // Keeping the most recent views bounds the document if Telegram is unreachable.
    user.outbox = user.outbox.filter(x => x.id !== id).slice(-(MAX_OUTBOX - 1));
    user.outbox.push({ id, userId: user.userId, chatId: user.chatId, view, createdAt: now, leaseUntil: 0, expiresAt });
  }
  private route(user: UserState, event: BotEvent, now: number): MessageView {
    const text = (event.text ?? '').trim();
    if (text.startsWith('/remind ')) return this.setReminder(user, text, now);
    if (text === '/privacy') return { text: 'Бот хранит ваш Telegram ID, настройки, учебный прогресс и результаты. Телефон и другие переписки не нужны. Данные не публикуются в GitHub. Для сброса прогресса используйте /reset. Доступ к данным имеет владелец бота.', buttons: [menuButton] };
    if (text === '/reset') return { text: 'Удалить ваш учебный прогресс, результаты и настройки напоминаний? Это действие нельзя отменить.', buttons: [[button('Сбросить мой прогресс', 'reset:confirm')], menuButton] };
    if (text === '/admin' && this.admins.has(user.userId)) return { text: `Доступ разрешён ${this.allowed.size} участникам.\nВерсия курса: ${this.course.version}\nВопросов: ${this.course.questions.length}; слов: ${this.course.vocabulary.length}; уроков: ${this.course.lessons.length}.\nСписок доступа задаётся в ALLOWED_USER_IDS / ADMIN_USER_IDS.`, buttons: [menuButton] };
    const action = event.action ?? ({ '/start': 'menu:home', '/menu': 'menu:home', '/today': 'menu:today', '/progress': 'menu:progress', '/help': 'menu:help', '/settings': 'menu:settings' } as Record<string, string>)[text.split('@')[0] ?? ''] ?? '';
    if (action === 'reset:confirm') {
      const fresh = initial(user.userId, user.chatId, now);
      Object.assign(user, fresh);
      return { text: 'Прогресс сброшен. Можно начать заново.', buttons: [[button('Начать', 'menu:today')], menuButton] };
    }
    if (action.startsWith('menu:')) {
      const name = action.slice(5);
      if (name === 'home') return this.menu(user);
      if (name === 'progress') return this.progress(user, now);
      if (name === 'settings') return this.settings(user);
      if (name === 'help') return { text: `Курс помогает понимать армянские вопросы и повторять нужные слова. В тренировке доступны подсказки; в пробном тесте их нет.\n\n${this.course.noticeRu}\n\n/start — меню\n/progress — прогресс\n/remind 19:00 Asia/Yerevan — напоминания\n/privacy — данные\n/reset — сброс\n\nТест в учебном боте не заменяет официальную процедуру.`, buttons: [menuButton] };
      if (name === 'continue' && user.session) return this.renderSession(user);
      if (name === 'exam') return { text: 'Пробный тест: 33 вопроса на армянском, 60 минут, проходной результат 17. Перевод и подсказки выключены.\n\nЭто авторские тренировочные вопросы, а не подтверждённый текущий официальный банк. Начало теста заменит незавершённое занятие.', buttons: [[button('Начать тест', 'start:exam')], menuButton] };
      if (name === 'lessons' || name.startsWith('lessons:')) return this.lessons(user, name.slice('lessons:'.length));
      if (name === 'today' && user.session && user.session.endedAt === null) return this.renderSession(user);
      if (name === 'today') return this.startToday(user, event.eventId, now);
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
    if (['answer', 'hint', 'next'].includes(parts[0] ?? '')) {
      if (!session || session.endedAt !== null || parts[1] !== session.id || Number(parts[2]) !== session.index) {
        return { text: 'Эта карточка уже завершена или устарела. Откройте текущее занятие.', buttons: [[button('Продолжить', 'menu:continue')], menuButton] };
      }
      if (parts[0] === 'hint') {
        if (session.kind !== 'exam' && !session.feedback && !session.hints.includes(session.index)) session.hints.push(session.index);
        return this.renderSession(user);
      }
      if (parts[0] === 'next') {
        if (session.feedback) { session.index++; session.feedback = false; if (session.index >= session.steps.length) this.finish(user, now, false); }
        return this.renderSession(user);
      }
      const selected = Number(parts[3]);
      if (!Number.isInteger(selected) || selected < 0 || selected > 2 || session.feedback) return this.renderSession(user);
      this.answer(user, selected, now);
      return this.renderSession(user);
    }
    return { text: 'Используйте кнопки под заданием или /start для меню. Напоминания: /remind 19:00 Asia/Yerevan.', buttons: [menuButton] };
  }
  private menu(user: UserState): MessageView {
    const rows = [[button('Сегодня · 15 минут', 'menu:today')], [button('Слова', 'menu:words'), button('Повторить', 'menu:review')],
      [button('Уроки', 'menu:lessons'), button('Тренировка', 'menu:practice')], [button('Пробный тест', 'menu:exam')],
      [button('Прогресс', 'menu:progress'), button('Настройки', 'menu:settings')], [button('О курсе', 'menu:help')]];
    const categories = (Object.keys(CATEGORY_LABELS) as VocabularyCategory[])
      .filter(category => this.course.vocabulary.some(word => word.category === category))
      .map(category => button(CATEGORY_LABELS[category], `menu:${category}`));
    if (categories.length) rows.splice(2, 0, categories);
    if (user.session && user.session.endedAt === null) rows.unshift([button('Продолжить занятие', 'menu:continue')]);
    return { text: `Армянский для теста на гражданство\n\nЧитаем вопросы, учим лексику и разбираем ответы.\n\n${this.course.noticeRu}`, buttons: rows };
  }
  private lessons(user: UserState, requestedPage: string): MessageView {
    const pages = Math.ceil(this.course.lessons.length / LESSONS_PER_PAGE);
    const parsed = Number(requestedPage);
    const page = Number.isSafeInteger(parsed) ? Math.max(0, Math.min(parsed, pages - 1)) : 0;
    const rows = this.course.lessons.slice(page * LESSONS_PER_PAGE, (page + 1) * LESSONS_PER_PAGE)
      .map(lesson => [button(`${user.completedLessons.includes(lesson.id) ? '✓ ' : ''}${lesson.titleRu}`, `lesson:${lesson.id}`)]);
    const navigation = [];
    if (page > 0) navigation.push(button('← Назад', `menu:lessons:${page - 1}`));
    if (page + 1 < pages) navigation.push(button('Дальше →', `menu:lessons:${page + 1}`));
    if (navigation.length) rows.push(navigation);
    rows.push(menuButton);
    return { text: `Уроки · страница ${page + 1}/${pages}\n\nВыберите короткое занятие. Отметка ✓ означает, что урок уже пройден.`, buttons: rows };
  }
  private progress(user: UserState, now: number): MessageView {
    const cards = Object.values(user.cards);
    const exams = user.exams.slice(-5).reverse().map(x => `${new Date(x.at).toISOString().slice(0, 10)}: ${x.score}/${x.total}${x.timedOut ? ' (время истекло)' : ''}`);
    return { text: `Ваш прогресс\n\nУроки: ${user.completedLessons.length}/${this.course.lessons.length}\nСлова в работе: ${cards.length}/${this.course.vocabulary.length}\nСлова на интервале 7+ дней: ${cards.filter(x => x.level >= 3).length}\nК повторению: ${cards.filter(x => x.dueAt <= now).length}\nОтветы без подсказок: ${user.correct}/${user.attempts}\n\nПоследние пробные тесты:\n${exams.length ? exams.join('\n') : 'Ещё не проходили.'}`, buttons: [[button('Повторить', 'menu:review')], menuButton] };
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
    const normalizeHy = (text: string) => text.normalize('NFC').trim().toLocaleLowerCase('hy-AM');
    const normalizeRu = (text: string) => text.normalize('NFC').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
    const glosses = (text: string) => text.split(/[,;/]/).map(normalizeRu).filter(Boolean);
    const usedGlosses = new Set(glosses(word.ru));
    const usedTranslations = new Set([normalizeRu(word.ru)]);
    const distractors = shuffled(this.course.vocabulary.filter(x => x.id !== word.id && normalizeHy(x.hy) !== normalizeHy(word.hy)), seed);
    const unique: string[] = [];
    for (const distractor of distractors) {
      const normalized = normalizeRu(distractor.ru), meanings = glosses(distractor.ru);
      if (!meanings.length || usedTranslations.has(normalized) || meanings.some(meaning => usedGlosses.has(meaning))) continue;
      unique.push(distractor.ru); usedTranslations.add(normalized);
      for (const meaning of meanings) usedGlosses.add(meaning);
      if (unique.length === 2) break;
    }
    if (unique.length < 2) throw new Error('At least three different vocabulary translations are required');
    const choices = shuffled([word.ru, ...unique], seed + word.id);
    return { kind: 'word', word, choices, correctIndex: choices.indexOf(word.ru) };
  }
  private startToday(user: UserState, seed: string, now: number): MessageView {
    const due = this.course.vocabulary.filter(x => user.cards[x.id] && user.cards[x.id]!.dueAt <= now).slice(0, 5);
    const lesson = this.course.lessons.find(x => !user.completedLessons.includes(x.id));
    if (!lesson) return this.startPractice(user, seed, now);
    return this.beginLesson(user, lesson.id, seed, now, due);
  }
  private beginLesson(user: UserState, id: string, seed: string, now: number, due: Vocabulary[] = []): MessageView {
    const lesson = this.course.lessons.find(x => x.id === id)!;
    const words = [...due, ...lesson.vocabularyIds.map(x => this.course.vocabulary.find(y => y.id === x)!)];
    const steps: Step[] = [...new Map(words.map(x => [x.id, x])).values()].map(x => this.wordStep(x, seed));
    steps.push(...lesson.questionIds.map(id => ({ kind: 'question' as const, question: this.course.questions.find(x => x.id === id)! })));
    return this.begin(user, 'lesson', `${lesson.titleRu}\n${lesson.introRu}`, steps, now, seed, lesson.id);
  }
  private startWords(user: UserState, seed: string, now: number, dueOnly: boolean, category?: VocabularyCategory): MessageView {
    const vocabulary = category ? this.course.vocabulary.filter(word => word.category === category) : this.course.vocabulary;
    const due = vocabulary.filter(x => user.cards[x.id] && user.cards[x.id]!.dueAt <= now);
    const words = dueOnly ? due : [...due, ...vocabulary.filter(x => !user.cards[x.id])];
    if (words.length === 0) {
      const text = category
        ? (vocabulary.length ? `В разделе «${CATEGORY_LABELS[category]}» все слова уже в работе. Повторений на сейчас нет. Можно выбрать урок или другой раздел.`
          : `В разделе «${CATEGORY_LABELS[category]}» пока нет слов. Выберите другой раздел или урок.`)
        : (dueOnly ? 'На сейчас повторений нет. Можно перейти к следующему уроку.' : 'Все слова уже в работе. Для практики откройте урок или повторения.');
      return { text, buttons: [[button('Уроки', 'menu:lessons')], menuButton] };
    }
    const title = category ? CATEGORY_LABELS[category] : (dueOnly ? 'Повторение слов' : 'Слова для теста');
    return this.begin(user, 'review', title, words.slice(0, 10).map(x => this.wordStep(x, seed)), now, seed);
  }
  private startPractice(user: UserState, seed: string, now: number): MessageView {
    const questions = shuffled(this.course.questions, seed).sort((a, b) => (user.questionMistakes[b.id] ?? 0) - (user.questionMistakes[a.id] ?? 0)).slice(0, 10);
    return this.begin(user, 'practice', 'Тренировка вопросов', questions.map(question => ({ kind: 'question', question })), now, seed);
  }
  private begin(user: UserState, kind: StudySession['kind'], title: string, steps: Step[], now: number, seed: string, lessonId: string | null = null): MessageView {
    user.session = { id: createHash('sha256').update(`${user.userId}:${seed}:${now}`).digest('hex').slice(0, 12), kind, title, lessonId,
      contentVersion: this.course.version, steps: structuredClone(steps), index: 0, answers: [], hints: [], feedback: false,
      startedAt: now, deadlineAt: kind === 'exam' ? now + 3600_000 : null, endedAt: null };
    return this.renderSession(user);
  }
  private answer(user: UserState, selected: number, now: number): void {
    const session = user.session!, step = session.steps[session.index]!;
    if (session.answers.some(x => x.step === session.index)) return;
    const correctIndex = step.kind === 'word' ? step.correctIndex : step.question.correctIndex;
    const correct = selected === correctIndex, hinted = session.hints.includes(session.index);
    session.answers.push({ step: session.index, selected, correct, hinted });
    user.attempts++; if (correct && !hinted) user.correct++;
    if (step.kind === 'word') {
      const card = user.cards[step.word.id] ?? { level: 0, dueAt: now, seen: 0, mistakes: 0 };
      card.seen++;
      if (correct && !hinted && card.dueAt <= now) { const days = INTERVALS[Math.min(card.level, 4)]!; card.level = Math.min(card.level + 1, 5); card.dueAt = now + days * DAY; }
      else if (correct && !hinted) { /* Extra practice does not advance a card before its due date. */ }
      else { card.level = 0; card.dueAt = now + 10 * 60_000; if (!correct) card.mistakes++; }
      user.cards[step.word.id] = card;
    } else if (!correct) user.questionMistakes[step.question.id] = (user.questionMistakes[step.question.id] ?? 0) + 1;
    else if (!hinted) user.questionMistakes[step.question.id] = Math.max(0, (user.questionMistakes[step.question.id] ?? 0) - 1);
    if (session.kind === 'exam') { session.index++; if (session.index >= session.steps.length) this.finish(user, now, false); }
    else session.feedback = true;
  }
  private finish(user: UserState, now: number, timedOut: boolean): void {
    const session = user.session!;
    if (session.endedAt !== null) return;
    session.endedAt = now;
    if (session.kind === 'exam') {
      user.exams.push({ at: now, score: session.answers.filter(x => x.correct).length, total: session.steps.length, timedOut, version: session.contentVersion });
      user.exams = user.exams.slice(-30);
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
      const outcome = exam ? `\n${score >= 17 ? 'Проходной результат тренировочного теста достигнут.' : 'Проходной результат пока не достигнут.'}\nПорог: 17 из 33.` : '\nОшибки и слова с подсказками вернутся в повторение.';
      return { text: `${exam ? 'Пробный тест завершён' : 'Занятие завершено'}\n\nСамостоятельно правильно: ${score}/${session.steps.length}.${outcome}\n\nЭто результат тренировки, не оценка официального экзамена.`, buttons: [[button('Разобрать ошибки', `mistakes:${session.id}:0`)], [button('Следующее занятие', 'menu:today')], menuButton] };
    }
    const step = session.steps[session.index]!;
    const prefix = `${session.title}\n\n${session.index + 1}/${session.steps.length}`;
    const timer = session.deadlineAt ? `\nОкончание: ${new Intl.DateTimeFormat('ru-RU', { timeZone: user.reminders.timeZone, hour: '2-digit', minute: '2-digit' }).format(session.deadlineAt)} (${user.reminders.timeZone}). 60 минут с начала теста.` : '';
    const prompt = step.kind === 'word' ? `Как переводится «${step.word.hy}»?` : step.question.promptHy;
    const options = step.kind === 'word' ? step.choices : step.question.options.map(x => x.hy);
    let text = `${prefix}${timer}\n\n${prompt}\n\n${options.map((value, i) => `${i + 1}. ${value}`).join('\n')}`;
    const isHinted = session.hints.includes(session.index);
    if (isHinted && session.kind !== 'exam') {
      text += step.kind === 'word' ? `\n\nПеревод: ${step.word.ru}` : `\n\nПеревод вопроса: ${step.question.promptRu}\n${step.question.options.map((x, i) => `${i + 1}. ${x.ru}`).join('\n')}`;
    }
    if (session.feedback) {
      const answer = session.answers.find(x => x.step === session.index)!;
      text += `\n\n${answer.correct ? 'Верно.' : 'Пока неверно.'}${answer.hinted ? ' Ответ с подсказкой не считается освоением.' : ''}\n`;
      text += step.kind === 'word' ? `${step.word.hy} — ${step.word.ru}${step.word.exampleHy ? `\n${step.word.exampleHy}\n${step.word.exampleRu ?? ''}` : ''}` : `${step.question.explanationRu}\nИсточник: ${step.question.source.article}\n${step.question.source.url}`;
      return { text, buttons: [[button('Дальше', `next:${session.id}:${session.index}`)], menuButton] };
    }
    const rows = [[0, 1, 2].map(i => button(String(i + 1), `answer:${session.id}:${session.index}:${i}`))];
    if (session.kind !== 'exam' && !isHinted) rows.push([button(step.kind === 'word' ? 'Показать перевод' : 'Перевод вопроса', `hint:${session.id}:${session.index}`)]);
    rows.push(menuButton);
    return { text, buttons: rows };
  }
  private mistakes(user: UserState, action: string): MessageView {
    const [, sid, pageText] = action.split(':'), session = user.session;
    if (!session || session.id !== sid || session.endedAt === null) return { text: 'Разбор доступен после завершения текущего занятия.', buttons: [menuButton] };
    const wrong = session.steps.map((step, index) => ({ step, answer: session.answers.find(a => a.step === index) })).filter(x => !x.answer?.correct || x.answer.hinted);
    if (!wrong.length) return { text: 'Ошибок и ответов с подсказкой нет.', buttons: [menuButton] };
    const parsed = Number(pageText), page = Number.isInteger(parsed) ? Math.max(0, Math.min(parsed, wrong.length - 1)) : 0;
    const { step, answer } = wrong[page]!;
    let text = `Разбор ${page + 1}/${wrong.length}\n${answer ? (answer.hinted ? 'Была использована подсказка.' : 'Ответ был неверным.') : 'Ответ не дан.'}\n\n`;
    text += step.kind === 'word' ? `${step.word.hy} — ${step.word.ru}` : `${step.question.promptHy}\n${step.question.promptRu}\n\nПравильный ответ: ${step.question.options[step.question.correctIndex]!.hy}\n${step.question.explanationRu}\n\n${step.question.source.article}\n${step.question.source.url}`;
    const navigation = [];
    if (page > 0) navigation.push(button('Назад', `mistakes:${sid}:${page - 1}`));
    if (page + 1 < wrong.length) navigation.push(button('Дальше', `mistakes:${sid}:${page + 1}`));
    return { text, buttons: navigation.length ? [navigation, menuButton] : [menuButton] };
  }
}
