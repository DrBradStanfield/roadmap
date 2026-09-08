import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

vi.mock('../shopify.server', () => ({
  authenticate: { public: { appProxy: vi.fn(async () => ({})) } },
}));

import { action } from './api.chat';

// US-15 AC4: a malformed body is the client's error. Node's SyntaxError quotes
// the offending text, so the outer catch must never see it.
const marker = 'PHI_SENTINEL';
let envelopes: unknown[];

beforeEach(() => {
  envelopes = [];
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    defaultIntegrations: false,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
});

afterEach(async () => {
  await Sentry.close();
  vi.restoreAllMocks();
});

describe('api.chat malformed body', () => {
  it('returns 400 and reports nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await action({
      request: new Request('https://drstanfield.com/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"message": ${marker} synthetic LDL 4.2`,
      }),
      params: {},
    } as unknown as Parameters<typeof action>[0]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain(marker);
    await Sentry.flush();
    expect(envelopes).toEqual([]);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(marker);
  });
});
