import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import type { LearningEngine, PendingDelivery } from './engine.js';
import { ConfigurationError } from './config.js';

export const TELEGRAM_TIMEOUT_SECONDS = 10;

export class DeliveryError extends Error {
  constructor() {
    super('One or more Telegram deliveries failed. Pending messages remain available for retry.');
    this.name = 'DeliveryError';
  }
}

function keyboardFor(view: PendingDelivery['view']): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, row] of (view.buttons ?? []).entries()) {
    if (index > 0) keyboard.row();
    for (const button of row) keyboard.text(button.text, button.data);
  }
  return keyboard;
}

function isUnchangedMessage(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400 && /message is not modified/i.test(error.description);
}

function isUneditableMessage(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400
    && /message to edit not found|message can't be edited|message identifier is not specified/i.test(error.description);
}

export async function assertNoWebhook(bot: Bot): Promise<void> {
  const webhook = await bot.api.getWebhookInfo();
  if (webhook.url) {
    throw new ConfigurationError('У этого бота уже установлен облачный webhook. Локальный запуск остановлен. Используйте отдельного тестового бота; webhook автоматически не удаляется.');
  }
}

export async function deliverPending(
  bot: Bot,
  engine: LearningEngine,
  pending: PendingDelivery[],
  context?: Context,
): Promise<void> {
  let failed = false;
  for (const [index, delivery] of pending.entries()) {
    let token = delivery.leaseToken;
    // A new event already owns its first delivery in the event transaction.
    // Refresh nearly expired leases; legacy/backlogged messages claim just before sending.
    if (!token || (delivery.leaseUntil ?? 0) < Date.now() + 25_000) {
      const nextToken = randomUUID();
      if (!(await engine.claim(delivery.userId, delivery.id, nextToken, token))) continue;
      token = nextToken;
    }
    try {
      const options = { reply_markup: keyboardFor(delivery.view) };
      const message = context?.callbackQuery?.message;
      const canEdit = index === pending.length - 1 && message
        && message.chat.id === delivery.chatId
        && context?.from?.id === delivery.userId;
      if (canEdit) {
        try {
          await bot.api.editMessageText(delivery.chatId, message.message_id, delivery.view.text, options);
        } catch (error) {
          if (isUnchangedMessage(error)) {
            // A retry after Telegram accepted an edit is already delivered.
          } else if (isUneditableMessage(error)) {
            await bot.api.sendMessage(delivery.chatId, delivery.view.text, options);
          } else {
            throw error;
          }
        }
      } else {
        await bot.api.sendMessage(delivery.chatId, delivery.view.text, options);
      }
      await engine.acknowledge(delivery.userId, delivery.id, token);
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 403) {
        // A blocked/deactivated chat cannot receive this message. Do not retry it.
        await engine.suppressNotifications(delivery.userId);
        await engine.acknowledge(delivery.userId, delivery.id, token);
      } else {
        await engine.release(delivery.userId, delivery.id, token);
        failed = true;
      }
    }
  }
  if (failed) throw new DeliveryError();
}

export function createTelegramBot(token: string, engine: LearningEngine): Bot {
  const bot = new Bot(token, { client: { timeoutSeconds: TELEGRAM_TIMEOUT_SECONDS } });

  bot.on('message:text', async (context) => {
    if (context.chat.type !== 'private' || context.from.is_bot) return;
    const pending = await engine.handle({
      userId: context.from.id,
      chatId: context.chat.id,
      eventId: String(context.update.update_id),
      text: context.message.text,
    }, true);
    await deliverPending(bot, engine, pending, context);
  });

  bot.on('callback_query:data', async (context) => {
    // Dismiss the Telegram spinner even for stale buttons. A failed acknowledgment
    // does not prevent a persisted answer from being processed.
    await context.answerCallbackQuery().catch(() => undefined);
    if (!context.chat || context.chat.type !== 'private' || context.from.is_bot) return;
    const pending = await engine.handle({
      userId: context.from.id,
      chatId: context.chat.id,
      eventId: String(context.update.update_id),
      action: context.callbackQuery.data,
    }, true);
    await deliverPending(bot, engine, pending, context);
  });

  return bot;
}
