// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://drstanfield.com/pages/health-roadmap"}
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as Sentry from '@sentry/react';
import { initSentry } from './sentry';

// US-67 AC2: a reply holding an entry of a known kind that is not its shape sends
// Sentry one message, tagged with the invalid kinds only: no value, no reply text.
// The real initSentry options (its beforeSend scrub included) through the real SDK;
// only the transport is swapped for a capturing one.
const envelopes = vi.hoisted(() => [] as Array<[Record<string, unknown>, Array<[{ type: string }, Record<string, unknown>]>]>);
vi.mock('@sentry/react', async (original) => {
  const real = await original<typeof import('@sentry/react')>();
  return {
    ...real,
    init: (options: Parameters<typeof real.init>[0]) => real.init({
      ...options,
      transport: () => ({
        send: async (envelope: never) => { envelopes.push(envelope); return { statusCode: 200 }; },
        flush: async () => true,
      }),
    }),
  };
});
const store = vi.hoisted(() => ({ recordExchange: vi.fn(async () => {}), eraseMarks: vi.fn(() => []) }));
vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(store), askChatHistory: () => Promise.resolve({ store, askedMarks: [] }) }));
vi.mock('./build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));

import { sendMessage } from './chat-api';

const REPLY_TEXT = 'Your LDL of 4.1 is noted and atorvastatin 40 mg saved';
const done = {
  type: 'done', success: true, conversationId: 'c1', messageId: null, content: REPLY_TEXT, isFallback: false,
  proposedEdits: [
    { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg' },
    { kind: 'medication', medicationKey: 'statin_escalation', drugName: 42, doseValue: null, doseUnit: null },
    { kind: 'field', field: 'ldlC', displayValue: '4.1', unitSystem: 'si', date: null },
    { kind: 'field', field: 'ldlC', displayValue: 4.1, unitSystem: 'si', date: null },
  ],
};

// The SDK's own clock and random ids supply digits by chance: "timestamp":1794449754.193
// carried '4.1' and turned main's CI red (9eae2713). Blank them before the search, each by its
// exact place in the envelope and only if it has the shape the SDK gives it; any other value at
// one of these places fails the test, so no real field can hide here. Freezing the clock would
// not do: the SDK reads performance.timeOrigin + performance.now(), not Date, and draws ids
// from crypto.
const EPOCH = (v: unknown) => typeof v === 'number' && v > 1e9 && v < 1e10;
const ISO = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v);
const HEX32 = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const HEX16 = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
const HEADER_NOISE: Record<string, (v: unknown) => boolean> = { event_id: HEX32, sent_at: ISO, 'trace.trace_id': HEX32 };
const EVENT_NOISE: Record<string, (v: unknown) => boolean> = {
  event_id: HEX32, timestamp: EPOCH, 'contexts.trace.trace_id': HEX32, 'contexts.trace.span_id': HEX16, 'breadcrumbs[].timestamp': EPOCH,
};
function blank(target: Record<string, unknown>, paths: Record<string, (v: unknown) => boolean>) {
  for (const [path, shape] of Object.entries(paths)) {
    const [head, tail] = path.split('[].');
    const keys = head.split('.');
    const parents = (tail ? (keys.reduce<any>((o, k) => o?.[k], target) ?? []) as Record<string, unknown>[] : [target]);
    const leafPath = tail ? tail.split('.') : keys;
    for (const parent of parents) {
      const owner = leafPath.slice(0, -1).reduce<any>((o, k) => o?.[k], parent);
      const leaf = leafPath.at(-1)!;
      if (owner === undefined || !(leaf in owner)) continue;
      if (!shape(owner[leaf])) throw new Error(`${path} does not have the SDK's shape: a real field may sit there`);
      owner[leaf] = '<sdk>';
    }
  }
}
function withoutSdkClockAndIds(sent: typeof envelopes) {
  const copy = JSON.parse(JSON.stringify(sent)) as typeof envelopes;
  for (const [header, items] of copy) {
    blank(header, HEADER_NOISE);
    for (const [itemHeader, body] of items) if (itemHeader.type === 'event') blank(body, EVENT_NOISE);
  }
  return copy;
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(done) + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })));
  initSentry();
});
afterAll(async () => {
  await Sentry.close();
  vi.unstubAllGlobals();
});

it('US-67 AC2: one message, tagged with the invalid kinds, carrying no value or reply text', async () => {
  const { result } = await sendMessage('my ldl is 4.1 and I take atorvastatin 40', null, null, [], () => {}, true);
  expect(result?.editRefusals?.map((r) => r.part)).toEqual(['medications', 'review']);
  await Sentry.flush(1000);

  const events = envelopes.flatMap(([, items]) => items).filter(([h]) => h.type === 'event').map(([, body]) => body);
  expect(events).toHaveLength(1);
  const [event] = events;
  expect(event.message).toBe('Chat edits unreadable');
  expect(event.level).toBe('warning');
  expect(event.tags).toEqual({ feature: 'chat-edits', invalid: 'medication,field' });
  expect(Object.keys(event).sort()).toEqual([
    'breadcrumbs', 'contexts', 'environment', 'event_id', 'level', 'message', 'platform', 'request', 'sdk', 'tags', 'timestamp',
  ]);
  expect(event.environment).toBe('production');
  const sent = JSON.stringify(withoutSdkClockAndIds(envelopes));
  expect(sent).toContain('Chat edits unreadable');
  for (const text of [REPLY_TEXT, 'atorvastatin', '4.1', 'statin_escalation', 'ldlC', 'my ldl']) expect(sent).not.toContain(text);
});
