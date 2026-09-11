import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { parseProductEvent, productEventSchema, SERVER_VISITOR_ID } from './product-events.server';

// supabase.server.ts builds its admin client at module load; route the
// product_events inserts through this controllable stub.
const inserts: Array<Record<string, unknown>> = [];

// The module under test imports Sentry to report rejected metadata. Stub it:
// the real SDK re-executes on the beforeAll resetModules() (~700ms a run), and
// a spy is what lets a test assert the report carries KEY NAMES only.
// vi.hoisted because vi.mock is lifted above plain const declarations.
const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureMessage, captureException: vi.fn() }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: vi.fn(async (row: Record<string, unknown>) => {
        inserts.push(row);
        return { error: null };
      }),
    })),
  })),
}));

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

  // The SERVER list carries `reason` too (US-32 AC29). The browser's must not:
  // SERVER_ONLY_EVENT_NAMES keeps mcp_tool_call out, and this keeps the key out.
  it('does not widen the browser allow-list with the server-only reason key', () => {
    expect(
      parseProductEvent({
        eventName: 'chat_opened',
        visitorId: VISITOR,
        metadata: { reason: 'slot-occupied' },
      }),
    ).toBeNull();
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

/** US-38 — the guide link's counter: which surface sent someone to the hub. */
describe('the guide-link counter', () => {
  it('takes a placement from the closed list', () => {
    for (const placement of ['header', 'footer']) {
      expect(
        productEventSchema.safeParse({
          eventName: 'guide_opened',
          visitorId: VISITOR,
          metadata: { placement },
        }).success,
        placement,
      ).toBe(true);
    }
  });

  it('refuses a placement the list does not name', () => {
    expect(
      productEventSchema.safeParse({
        eventName: 'guide_opened',
        visitorId: VISITOR,
        metadata: { placement: 'sidebar' },
      }).success,
    ).toBe(false);
  });
});

/**
 * US-32 AC29 — the "closed allow-list" guarantee has to hold on the SERVER
 * path too: `recordServerEvent` used to insert whatever it was handed.
 */
describe('recordServerEvent — the server path validates too', () => {
  let recordServerEvent: typeof import('./product-events.server').recordServerEvent;

  beforeAll(async () => {
    vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'stub-service-key');
    vi.stubEnv('SUPABASE_ANON_KEY', 'stub-anon-key');
    vi.stubEnv('SUPABASE_JWT_SECRET', 'stub-jwt-secret');
    vi.resetModules();
    ({ recordServerEvent } = await import('./product-events.server'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    inserts.length = 0;
    captureMessage.mockClear();
  });

  // THE REGRESSION GUARD: the US-22 email funnel passes no metadata at all.
  // Validating with the bare (non-optional) schema would drop every one.
  it('records the metadata-free server families', async () => {
    for (const eventName of [
      'report_email_sent',
      'report_email_clicked',
      'report_email_complained',
      'report_email_bounced',
    ] as const) {
      await recordServerEvent(eventName);
    }
    expect(inserts.map((row) => row.event_name)).toEqual([
      'report_email_sent',
      'report_email_clicked',
      'report_email_complained',
      'report_email_bounced',
    ]);
    expect(inserts.every((row) => row.metadata === null)).toBe(true);
  });

  it('keeps a refusal reason from the closed vocabulary', async () => {
    await recordServerEvent('mcp_tool_call', {
      tool: 'add_measurement',
      client: 'claude',
      outcome: 'refused',
      reason: 'slot-occupied',
    });
    expect(inserts[0]?.metadata).toEqual({
      tool: 'add_measurement',
      client: 'claude',
      outcome: 'refused',
      reason: 'slot-occupied',
    });
  });

  it('does not write a reason the vocabulary does not name', async () => {
    await recordServerEvent('mcp_tool_call', {
      tool: 'add_measurement',
      client: 'claude',
      outcome: 'refused',
      reason: 'ldl 4.2' as never,
    });
    expect(JSON.stringify(inserts)).not.toContain('4.2');
    expect(inserts[0]?.metadata).toBeNull();
  });

  it('drops an undeclared key before the insert', async () => {
    await recordServerEvent('mcp_connect', { foo: 'bar' } as never);
    expect(JSON.stringify(inserts)).not.toContain('foo');
    expect(inserts[0]?.metadata).toBeNull();
  });

  // The report exists so a misbehaving caller is visible. It must name the
  // KEYS and never the value: the value is the thing we refused to store.
  it('reports a rejection by key name, never by value', async () => {
    await recordServerEvent('mcp_connect', { ldl: '4.2 mmol/L' } as never);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessage.mock.calls[0];
    expect(message).toBe('product_events: server metadata rejected');
    expect(options).toMatchObject({ level: 'warning', tags: { feature: 'product_events' } });
    expect(options.extra).toEqual({ eventName: 'mcp_connect', keys: ['ldl'] });
    expect(JSON.stringify(options)).not.toContain('4.2');
  });

  it('reports nothing when the metadata is clean', async () => {
    await recordServerEvent('mcp_connect', { client: 'claude', provider: 'dropbox' });
    expect(captureMessage).not.toHaveBeenCalled();
  });

});
