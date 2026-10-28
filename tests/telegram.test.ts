import { describe, expect, it, vi } from 'vitest';
import { GrammyError, type Bot, type Context } from 'grammy';
import type { LearningEngine, PendingDelivery } from '../src/engine.js';
import { assertNoWebhook, createTelegramBot, deliverPending } from '../src/telegram.js';

function makeEngine() {
  return {
    claim: vi.fn().mockResolvedValue(true),
    acknowledge: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    suppressNotifications: vi.fn().mockResolvedValue(undefined),
  };
}
function makeBot() {
  return { api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue({ message_id: 42 }),
    getWebhookInfo: vi.fn().mockResolvedValue({ url: '' }),
    deleteWebhook: vi.fn(),
  } };
}
function pending(id = 'delivery-one', userId = 1): PendingDelivery {
  return { id, userId, chatId: userId, view: { text: 'Учебное сообщение', buttons: [[{ text: 'Дальше', data: 'next' }]] } };
}
function apiError(code: number, description: string): GrammyError {
  return new GrammyError('API error', { ok: false, error_code: code, description }, 'sendMessage', {});
}
const callbackContext = {
  from: { id: 1 },
  callbackQuery: { message: { message_id: 42, chat: { id: 1 } } },
} as unknown as Context;

describe('Telegram delivery reliability', () => {
  it('does not send an already claimed delivery', async () => {
    const engine = makeEngine();
    engine.claim.mockResolvedValue(false);
    const bot = makeBot();
    await deliverPending(bot as unknown as Bot, engine as unknown as LearningEngine, [pending()]);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(engine.acknowledge).not.toHaveBeenCalled();
  });

  it('acknowledges only after successful sending', async () => {
    const engine = makeEngine();
    const bot = makeBot();
    bot.api.sendMessage.mockImplementation(async () => {
      expect(engine.acknowledge).not.toHaveBeenCalled();
      return { message_id: 42 };
    });
    await deliverPending(bot as unknown as Bot, engine as unknown as LearningEngine, [pending()]);
    expect(engine.acknowledge).toHaveBeenCalledWith(1, 'delivery-one', expect.any(String));
    expect(engine.release).not.toHaveBeenCalled();
  });

  it('releases transient failures for a later retry without exposing original errors', async () => {
    const engine = makeEngine();
    const bot = makeBot();
    bot.api.sendMessage.mockRejectedValue(new Error('secret-bearing-network-error'));
    await expect(deliverPending(bot as unknown as Bot, engine as unknown as LearningEngine, [pending()]))
      .rejects.toThrow('Pending messages remain available for retry');
    expect(engine.release).toHaveBeenCalledWith(1, 'delivery-one', expect.any(String));
    expect(engine.acknowledge).not.toHaveBeenCalled();
  });

  it('treats an already applied edit as delivered', async () => {
    const engine = makeEngine();
    const bot = makeBot();
    bot.api.editMessageText.mockRejectedValue(apiError(400, 'Bad Request: message is not modified'));
    await deliverPending(bot as unknown as Bot, engine as unknown as LearningEngine, [pending()], callbackContext);
    expect(engine.acknowledge).toHaveBeenCalledWith(1, 'delivery-one', expect.any(String));
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a replacement when the original Telegram card was deleted', async () => {
    const engine = makeEngine();
    const bot = makeBot();
    bot.api.editMessageText.mockRejectedValue(apiError(400, 'Bad Request: message to edit not found'));
    await deliverPending(bot as unknown as Bot, engine as unknown as LearningEngine, [pending()], callbackContext);
    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    expect(engine.acknowledge).toHaveBeenCalledWith(1, 'delivery-one', expect.any(String));
  });

  it('suppresses notifications after a user blocks the bot', async () => {
    const engine = makeEngine();
    const bot = makeBot();
    bot.api.sendMessage.mockRejectedValue(apiError(403, 'Forbidden: bot was blocked by the user'));
    await deliverPending(bot as unknown as Bot, engine as unknown as LearningEngine, [pending()]);
    expect(engine.suppressNotifications).toHaveBeenCalledWith(1);
    expect(engine.acknowledge).toHaveBeenCalledWith(1, 'delivery-one', expect.any(String));
    expect(engine.release).not.toHaveBeenCalled();
  });

  it('still sends other pending messages when one recipient has a transient failure', async () => {
    const engine = makeEngine();
    const bot = makeBot();
    bot.api.sendMessage.mockRejectedValueOnce(new Error('network failure'));
    await expect(deliverPending(bot as unknown as Bot, engine as unknown as LearningEngine, [pending(), pending('delivery-two', 2)]))
      .rejects.toThrow();
    expect(engine.acknowledge).toHaveBeenCalledWith(2, 'delivery-two', expect.any(String));
    expect(engine.release).toHaveBeenCalledWith(1, 'delivery-one', expect.any(String));
  });

  it('never removes a live webhook to start local polling', async () => {
    const bot = makeBot();
    bot.api.getWebhookInfo.mockResolvedValue({ url: 'https://example.test/production-webhook' });
    await expect(assertNoWebhook(bot as unknown as Bot)).rejects.toThrow('webhook');
    expect(bot.api.deleteWebhook).not.toHaveBeenCalled();
  });
});

describe('Telegram input boundaries', () => {
  function botWithFakeEngine() {
    const engine = {
      ...makeEngine(),
      handle: vi.fn().mockResolvedValue([]),
    };
    const bot = createTelegramBot(`1:${'x'.repeat(24)}`, engine as unknown as LearningEngine);
    bot.botInfo = {
      id: 900, is_bot: true, first_name: 'Test', username: 'test_bot',
      can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false,
    };
    // This transformer never contacts Telegram.
    const methods: string[] = [];
    bot.api.config.use(async (_previous, method) => {
      methods.push(method);
      return { ok: true, result: true } as never;
    });
    return { bot, engine, methods };
  }

  it('does not process messages from groups', async () => {
    const { bot, engine } = botWithFakeEngine();
    await bot.handleUpdate({
      update_id: 10,
      message: { message_id: 1, date: 1, chat: { id: -100, type: 'group', title: 'Group' }, from: { id: 1, is_bot: false, first_name: 'Test' }, text: '/start' },
    });
    expect(engine.handle).not.toHaveBeenCalled();
  });

  it('passes private messages with the Telegram update ID for deduplication', async () => {
    const { bot, engine } = botWithFakeEngine();
    await bot.handleUpdate({
      update_id: 11,
      message: { message_id: 2, date: 1, chat: { id: 1, type: 'private', first_name: 'Test' }, from: { id: 1, is_bot: false, first_name: 'Test' }, text: '/start' },
    });
    expect(engine.handle).toHaveBeenCalledWith({ userId: 1, chatId: 1, eventId: '11', text: '/start' }, true);
  });

  it('acknowledges callback buttons and passes the action to the engine', async () => {
    const { bot, engine, methods } = botWithFakeEngine();
    await bot.handleUpdate({
      update_id: 12,
      callback_query: {
        id: 'query-one', chat_instance: 'instance', from: { id: 1, is_bot: false, first_name: 'Test' }, data: 'menu:today',
        message: { message_id: 3, date: 1, chat: { id: 1, type: 'private', first_name: 'Test' }, text: 'Menu' },
      },
    });
    expect(methods).toEqual(['answerCallbackQuery']);
    expect(engine.handle).toHaveBeenCalledWith({ userId: 1, chatId: 1, eventId: '12', action: 'menu:today' }, true);
  });
});
