import { describe, it, expect } from 'vitest';
import { PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { parseProductEvent, productEventSchema, SERVER_VISITOR_ID } from './product-events.server';

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';
const SERVER_ONLY = new Set<string>(SERVER_ONLY_EVENT_NAMES);

describe('parseProductEvent', () => {
  it('accepts every client-emittable event name', () => {
    for (const eventName of PRODUCT_EVENT_NAMES) {
      if (SERVER_ONLY.has(eventName)) continue;
      expect(parseProductEvent({ eventName, visitorId: VISITOR })).toEqual({
        eventName,
        visitorId: VISITOR,
      });
    }
  });

  // Adversarial review 2026-08-30: server-originated counters (reminder_sent,
  // report_email_*) were browser-forgeable through api.events, byte-identical
  // to the real cron/webhook rows — the loop reads these as evidence.
  it('rejects server-only event names from the client route', () => {
    for (const eventName of SERVER_ONLY_EVENT_NAMES) {
      expect(parseProductEvent({ eventName, visitorId: VISITOR })).toBeNull();
    }
  });

  it('rejects the server sentinel visitor id from the client route', () => {
    expect(parseProductEvent({ eventName: 'chat_opened', visitorId: SERVER_VISITOR_ID })).toBeNull();
  });

  it('rejects unknown event names (client/server enum drift)', () => {
    expect(parseProductEvent({ eventName: 'made_up_event', visitorId: VISITOR })).toBeNull();
  });

  it('rejects a non-UUID visitor id', () => {
    expect(parseProductEvent({ eventName: 'chat_opened', visitorId: 'not-a-uuid' })).toBeNull();
  });

  it('accepts allow-listed metadata', () => {
    expect(
      parseProductEvent({
        eventName: 'cloud_connect_success',
        visitorId: VISITOR,
        metadata: { provider: 'dropbox' },
      }),
    ).toMatchObject({ metadata: { provider: 'dropbox' } });
    expect(
      parseProductEvent({
        eventName: 'upload_saved',
        visitorId: VISITOR,
        metadata: { count: 12 },
      }),
    ).toMatchObject({ metadata: { count: 12 } });
  });

  it('rejects metadata outside the allow-list (no free text, no health values)', () => {
    expect(
      parseProductEvent({
        eventName: 'upload_saved',
        visitorId: VISITOR,
        metadata: { note: 'my LDL is 4.2' },
      }),
    ).toBeNull();
    expect(
      parseProductEvent({
        eventName: 'cloud_connect_success',
        visitorId: VISITOR,
        metadata: { provider: 'icloud' },
      }),
    ).toBeNull();
    expect(
      parseProductEvent({
        eventName: 'upload_saved',
        visitorId: VISITOR,
        metadata: { count: 5.5 },
      }),
    ).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(parseProductEvent({ eventName: 'chat_opened' })).toBeNull();
    expect(parseProductEvent({ visitorId: VISITOR })).toBeNull();
    expect(parseProductEvent(null)).toBeNull();
  });
});

/**
 * US-32 — the connector counters. They answer "how much is this used", never
 * "what does this person's record say", and never "who": no values, no
 * connection key, no client-supplied text.
 */
describe('the hosted MCP counters', () => {
  it('takes a tool call as tool + client + outcome, all from closed lists', () => {
    const event = productEventSchema.safeParse({
      eventName: 'mcp_tool_call',
      visitorId: SERVER_VISITOR_ID,
      metadata: { tool: 'add_measurement', client: 'claude', outcome: 'ok' },
    });
    expect(event.success).toBe(true);
  });

  it('refuses a tool that is not published, and an assistant that names itself', () => {
    for (const metadata of [
      { tool: 'delete_everything', client: 'claude', outcome: 'ok' },
      { tool: 'add_measurement', client: 'https://evil.test/client.json', outcome: 'ok' },
      { tool: 'add_measurement', client: 'claude', outcome: 'ldl 4.2' },
      { tool: 'add_measurement', client: 'claude', outcome: 'ok', clientId: 'https://evil.test/client.json' },
    ]) {
      expect(
        productEventSchema.safeParse({ eventName: 'mcp_tool_call', visitorId: SERVER_VISITOR_ID, metadata }).success,
        JSON.stringify(metadata),
      ).toBe(false);
    }
  });

  it('cannot be forged from a browser', () => {
    for (const eventName of ['mcp_tool_call', 'mcp_connect']) {
      expect(parseProductEvent({ eventName, visitorId: VISITOR })).toBeNull();
    }
  });
});
