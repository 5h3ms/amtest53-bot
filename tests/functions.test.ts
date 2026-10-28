import { afterEach, describe, expect, it, vi } from 'vitest';
import { telegramWebhook } from '../src/functions.js';

afterEach(() => vi.unstubAllEnvs());

async function request(method: string, secret: string | undefined, body: unknown) {
  vi.stubEnv('WEBHOOK_SECRET', 's'.repeat(32));
  const response = { on: vi.fn(), set: vi.fn(), status: vi.fn(), send: vi.fn() };
  response.on.mockReturnValue(response);
  response.set.mockReturnValue(response);
  response.status.mockReturnValue(response);
  response.send.mockReturnValue(response);
  const req = { method, headers: {}, get: () => secret, body };
  await telegramWebhook(req as Parameters<typeof telegramWebhook>[0], response as unknown as Parameters<typeof telegramWebhook>[1]);
  return response;
}

describe('HTTP webhook boundary', () => {
  it('only accepts POST', async () => {
    const response = await request('GET', undefined, {});
    expect(response.status).toHaveBeenCalledWith(405);
    expect(response.set).toHaveBeenCalledWith('Allow', 'POST');
  });

  it('rejects missing and incorrect webhook credentials before runtime initialization', async () => {
    for (const secret of [undefined, 'bad-secret', 't'.repeat(32)]) {
      const response = await request('POST', secret, { update_id: 1 });
      expect(response.status).toHaveBeenCalledWith(401);
    }
  });

  it('rejects malformed updates even with the correct secret', async () => {
    for (const body of [null, 'not-json', {}, { update_id: 1.5 }, { update_id: '1' }]) {
      const response = await request('POST', 's'.repeat(32), body);
      expect(response.status).toHaveBeenCalledWith(400);
    }
  });
});
