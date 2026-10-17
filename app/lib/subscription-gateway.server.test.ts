/**
 * US-49: the chatbot's door to the customer-service gateway for subscription
 * changes. Commerce only, signed both ways, propose-only, and no token ever in
 * the model's view. The gateway itself is stubbed (global fetch).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import {
  subscriptionActionsEnabled, signGatewayRequest, proxyParams, formatSubscriptionBlock,
  parseSubscriptionProposal, subscriptionCard, getCachedSubscriptions, invalidateSubscriptions,
  postSubscriptionAction, PROPOSE_SUBSCRIPTION_CHANGE_TOOL, SUBSCRIPTION_HELP_LINE, type SubscriptionSummary,
} from './subscription-gateway.server';

const SECRET = 'g'.repeat(40);
const ENV = { CHAT_SUBSCRIPTION_ACTIONS: 'on', CHAT_SURFACE: 'brand', CS_GATEWAY_CHAT_URL: 'http://gateway.test:8081', CHAT_GATEWAY_SECRET: SECRET };
const SIGNED_URL = 'https://health-tool-app.fly.dev/api/chat?shop=microvitamin.myshopify.com&logged_in_customer_id=7001&path_prefix=%2Fapps%2Fhealth-tool-1&timestamp=1760000000&signature=abc';

const summary: SubscriptionSummary = {
  enabled: true,
  subscriptions: [
    { ref: 'S1', product: 'MicroVitamin', status: 'active', every: '3 months', onPolicy: true, nextDate: '6 January 2027',
      actions: { pause: { ok: true, token: 'tok-pause-S1-xxxxxxxxxxxxxxxx' }, skip: { ok: true, token: 'tok-skip-S1-xxxxxxxxxxxxxxxx', newDate: '6 April 2027' }, cancel: { ok: true, token: 'tok-cancel-S1-xxxxxxxxxxxxxxx' } } },
    { ref: 'S2', product: 'Sleep', status: 'active', every: 'month', onPolicy: false, nextDate: '1 December 2026',
      actions: { pause: { ok: true, token: 'tok-pause-S2-xxxxxxxxxxxxxxxx' }, skip: { ok: false, code: 'off_policy' }, cancel: { ok: true, token: 'tok-cancel-S2-xxxxxxxxxxxxxxx' } } },
  ],
};

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.unstubAllGlobals();
  invalidateSubscriptions('7001');
});

describe('US-49 AC1: commerce only, behind its own switch', () => {
  it('needs the switch, the brand surface, the gateway URL and the secret', () => {
    expect(subscriptionActionsEnabled()).toBe(true);
    delete process.env.CHAT_SURFACE;
    expect(subscriptionActionsEnabled()).toBe(false); // the education app (doctor posture) never has it
    process.env.CHAT_SURFACE = 'brand';
    process.env.CHAT_SUBSCRIPTION_ACTIONS = 'off';
    expect(subscriptionActionsEnabled()).toBe(false);
    process.env.CHAT_SUBSCRIPTION_ACTIONS = 'on';
    process.env.CHAT_GATEWAY_SECRET = 'short';
    expect(subscriptionActionsEnabled()).toBe(false);
  });
});

describe('US-49 AC2: signed both ways', () => {
  it('signs method, path, timestamp, one-time value and body exactly as the gateway checks them', () => {
    // Vector from the gateway's own signer (customer-service-gateway src/chat/auth.js sign).
    const h = signGatewayRequest({ method: 'POST', path: '/chat/subscriptions', body: '{"proxy":{}}', secret: 's'.repeat(40), now: 1760000000000, nonce: 'abcdefabcdefabcdef' });
    expect(h['x-gateway-signature']).toBe('0dfdec6199e11564a0f81ed7c66172160a42c144a8456ba0415125ee1db6881a');
    expect(h['x-gateway-timestamp']).toBe('1760000000000');
  });

  it('forwards the app-proxy query exactly as Shopify signed it, repeated keys kept', () => {
    expect(proxyParams(new Request(`${SIGNED_URL}&x=1&x=2`))).toEqual({
      shop: ['microvitamin.myshopify.com'], logged_in_customer_id: ['7001'], path_prefix: ['/apps/health-tool-1'], timestamp: ['1760000000'], signature: ['abc'], x: ['1', '2'],
    });
  });

  it('the summary call carries the signed query and the HMAC, never a bare customer id; it is cached; a 403 is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, ...summary }));
    vi.stubGlobal('fetch', fetchMock);
    const got = await getCachedSubscriptions(new Request(SIGNED_URL), '7001');
    expect(got?.subscriptions).toHaveLength(2);
    await getCachedSubscriptions(new Request(SIGNED_URL), '7001');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test:8081/chat/subscriptions');
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(['proxy']);
    expect(body.proxy.logged_in_customer_id).toEqual(['7001']);
    expect(init.headers['x-gateway-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(init.redirect).toBe('error');
    invalidateSubscriptions('7001');
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    expect(await getCachedSubscriptions(new Request(SIGNED_URL), '7001')).toBeNull();
  });

  it('off at the gateway, or off here: nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, enabled: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getCachedSubscriptions(new Request(SIGNED_URL), '7001')).toBeNull();
    process.env.CHAT_SURFACE = 'doctor';
    invalidateSubscriptions('7001');
    expect(await getCachedSubscriptions(new Request(SIGNED_URL), '7001')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the confirm forwards the token and a reason code, and passes back only the fixed fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, status: 'done', newDate: '6 April 2027', extra: 'dropped' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await postSubscriptionAction(new Request(SIGNED_URL), 'tok-pause-S1-xxxxxxxxxxxxxxxx', 'have_enough')).toEqual({ status: 'done', newDate: '6 April 2027' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ token: 'tok-pause-S1-xxxxxxxxxxxxxxxx', reason: 'have_enough' });
    fetchMock.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await postSubscriptionAction(new Request(SIGNED_URL), 'tok', null)).toEqual({ status: 'unconfirmed' });
  });
});

describe('US-49 AC3: the model sees facts and rules, never a token', () => {
  it('lists each subscription with what can be proposed, and the 3-or-6-month rule', () => {
    const block = formatSubscriptionBlock(summary);
    expect(block).not.toContain('tok-');
    expect(block).toContain('S1: MicroVitamin, every 3 months, active, next order 6 January 2027');
    expect(block).toContain('skip the next order: yes (moves it to 6 April 2027)');
    expect(block).toContain('skip the next order: no (not every 3 or 6 months)');
    expect(formatSubscriptionBlock({ enabled: true, subscriptions: [{ ...summary.subscriptions![0], actions: { ...summary.subscriptions![0].actions, pause: { ok: false, code: 'held_unresolved' } } }] }))
      .toContain('pause: no (a recent change is still being checked)');
    expect(block).toContain('never offer monthly deliveries, an earlier date');
    expect(block).toContain(SUBSCRIPTION_HELP_LINE);
    expect(block).not.toMatch(/urgent/i);
  });
  it('unreadable or none', () => {
    expect(formatSubscriptionBlock({ enabled: true, error: 'unavailable' })).toContain(SUBSCRIPTION_HELP_LINE);
    expect(formatSubscriptionBlock({ enabled: true, subscriptions: [] })).toContain('no active or paused subscription');
  });
});

describe('US-49 AC4: a proposal becomes a card only for a listed subscription and an allowed action', () => {
  const use = (input: unknown) => [{ type: 'tool_use', name: PROPOSE_SUBSCRIPTION_CHANGE_TOOL.name, input }];
  it('parses one valid proposal; ignores junk; no reason on a skip', () => {
    expect(parseSubscriptionProposal(use({ subscription: 'S1', action: 'cancel', reason: 'too_expensive' }))).toEqual({ ref: 'S1', action: 'cancel', reason: 'too_expensive' });
    expect(parseSubscriptionProposal(use({ subscription: 'S1', action: 'skip', reason: 'too_expensive' }))).toEqual({ ref: 'S1', action: 'skip', reason: null });
    expect(parseSubscriptionProposal(use({ subscription: 'S1', action: 'pause', reason: 'free text here' }))?.reason).toBeNull();
    expect(parseSubscriptionProposal(use({ subscription: 'jane@example.com', action: 'cancel' }))).toBeNull();
    expect(parseSubscriptionProposal(use({ subscription: 'S1', action: 'monthly' }))).toBeNull();
    expect(parseSubscriptionProposal([{ type: 'tool_use', name: 'propose_field_edit', input: { subscription: 'S1', action: 'cancel' } }])).toBeNull();
  });
  it('the card carries the gateway token and plain facts; refused actions and unknown refs make no card', () => {
    expect(subscriptionCard(summary, { ref: 'S1', action: 'skip', reason: null })).toEqual({
      token: 'tok-skip-S1-xxxxxxxxxxxxxxxx', action: 'skip', product: 'MicroVitamin', every: '3 months', nextDate: '6 January 2027', newDate: '6 April 2027', reason: null,
    });
    expect(subscriptionCard(summary, { ref: 'S2', action: 'skip', reason: null })).toBeNull();
    expect(subscriptionCard(summary, { ref: 'S9', action: 'cancel', reason: null })).toBeNull();
    expect(subscriptionCard(null, { ref: 'S1', action: 'cancel', reason: null })).toBeNull();
  });
});

// US-49 AC10 (live pilot, 18 Oct): the rules the first pilot test showed were missing.
describe('formatSubscriptionBlock pilot rules (AC10)', () => {
  it('refuses other frequencies and earlier dates without the account link, never calls a card waiting, and drops the medical line', () => {
    const block = formatSubscriptionBlock({ enabled: true, subscriptions: [{ ref: 's1', product: 'MicroVitamin', every: '3 months', status: 'active', nextDate: '15 April 2027', actions: { pause: { ok: true }, skip: { ok: true, newDate: '15 July 2027' }, cancel: { ok: true } } } as any] });
    expect(block).toMatch(/monthly deliveries, another frequency or an earlier order date[^\n]*Do not point them to their account/);
    expect(block).toMatch(/Never say an earlier card is still waiting, and never tell them not to press Confirm/);
    expect(block).toMatch(/can lag a change by up to a minute/);
    expect(block).toMatch(/needs no line about medical advice/);
  });
});

