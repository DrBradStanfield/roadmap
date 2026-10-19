import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { isLabUnitWord, PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { acceptedLabUnits, CATALOG_UNITS, LAB_CATALOG } from '../../packages/health-core/src/lab-catalog';
import { UNIT_DEFS } from '../../packages/health-core/src/units';
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
  it('does not take the server-only `via` key from a browser (US-32 AC38)', () => {
    expect(parseProductEvent({ eventName: 'results_viewed', visitorId: VISITOR, metadata: { via: 'reviewer' } })).toBeNull();
  });

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

/**
 * US-22 AC13 + US-23 AC10 — the email-arrival counters. A browser may say an
 * email arrival found no plan (name only); only the server may count a
 * reminder-button click, as it counts the plan-ready one.
 */
describe('the email-arrival counters', () => {
  it('takes email_landing_empty from a browser, with no metadata (US-22 AC13)', () => {
    expect(PRODUCT_EVENT_NAMES).toContain('email_landing_empty');
    expect(parseProductEvent({ eventName: 'email_landing_empty', visitorId: VISITOR })).toEqual({
      eventName: 'email_landing_empty',
      visitorId: VISITOR,
    });
  });

  it('keeps reminder_email_clicked server-only, like report_email_clicked (US-23 AC10)', () => {
    expect(PRODUCT_EVENT_NAMES).toContain('reminder_email_clicked');
    expect(SERVER_ONLY_EVENT_NAMES).toContain('reminder_email_clicked');
    expect(parseProductEvent({ eventName: 'reminder_email_clicked', visitorId: VISITOR })).toBeNull();
  });

  it('takes email_landing_link_copied from a browser, with no metadata (US-22 AC14)', () => {
    expect(PRODUCT_EVENT_NAMES).toContain('email_landing_link_copied');
    expect(parseProductEvent({ eventName: 'email_landing_link_copied', visitorId: VISITOR })).toEqual({
      eventName: 'email_landing_link_copied',
      visitorId: VISITOR,
    });
    expect(parseProductEvent({ eventName: 'email_landing_link_copied', visitorId: VISITOR, metadata: { key: 'x' } })).toBeNull();
  });

  it('takes pdf_window_blocked from a browser, with no metadata (US-18 AC6)', () => {
    expect(PRODUCT_EVENT_NAMES).toContain('pdf_window_blocked');
    expect(parseProductEvent({ eventName: 'pdf_window_blocked', visitorId: VISITOR })).toEqual({
      eventName: 'pdf_window_blocked',
      visitorId: VISITOR,
    });
    expect(parseProductEvent({ eventName: 'pdf_window_blocked', visitorId: VISITOR, metadata: { key: 'x' } })).toBeNull();
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

/** US-34 — which tier a live re-read came in on: another tab of this
 *  browser (local), or another device or an assistant (cloud). */
describe('the remote-change counter', () => {
  it('takes a backend from the closed list, from a browser', () => {
    for (const backend of ['local', 'cloud']) {
      expect(parseProductEvent({ eventName: 'remote_change_applied', visitorId: VISITOR, metadata: { backend } }), backend)
        .toEqual({ eventName: 'remote_change_applied', visitorId: VISITOR, metadata: { backend } });
    }
  });

  it('refuses a backend the list does not name, a provider name included', () => {
    for (const backend of ['dropbox', 'Local', '', 1]) {
      expect(parseProductEvent({ eventName: 'remote_change_applied', visitorId: VISITOR, metadata: { backend } }), String(backend))
        .toBeNull();
    }
  });
});

// A value can hide inside a unit-shaped string: a decimal ("5.2 mmol"), a
// leading count ("141 mmol/L") or a bracketed number ("(5.2)"). Each is
// refused, on the browser route and the server's own path alike; the one
// decimal a unit is spelled with, eGFR's "1.73" m², stays.
const NUMBER_IN_UNIT = [
  '5.2 mmol', '141 mmol/L', '(5.2)', '5,2 g/dl', '(141)', 'mmol/L 5.2', '11.73m²',
  'mL/min/1.73m² 4.2', '1.73.5', '0 mmol/L', '-5 U/L', '( 5 )', 'g/L (3,5)',
  '141mmol/L', 'mmol/L 141', 'H 141', 'mmol/L141', 'g/L 10', '7 H',
  // A number a unit is spelled with is not a licence for that number anywhere:
  // only the constructions themselves pass (10^n, /1.73 m², mm3, /100, /24h).
  '9mg/dL', '100mmol/L', 'mmol/L9', '6%', '24mmol/L', '10mmol/L', '100mg/dL', 'mmol/L12',
  '10 mmol/L', '3·6 mmol/L', '¹⁴¹ mmol/L', 'mmol/L²', '110^9/L', '10^912/L', '/1000 WBC',
  '1.73 mmol/L', 'mmol/L 1.73',
  // Only the exponents units use: a value never rides in as a power of ten.
  'x10^47/L', '10^7/L', '10⁴⁷/L', '10e8/L',
  // Digits from outside ASCII and the superscripts never pass.
  '１４１ mmol/L', 'Ⅴ mmol', '½ g/L', '٣ mmol/L',
  // A result flag or a qualitative result is a value too (US-21 AC11): "mmol/L H"
  // on a potassium row says the potassium was high.
  'mmol/L H', 'mmol/L (H)', 'mmol/L HIGH', 'pmol/L L', 'mmol/L *', 'mmol/L*', '*', '10*3*/µL',
  'Positive', 'Reactive', 'Non-Reactive', 'nonreactive', 'not detected', 'Detected', 'NEG', 'pos',
  'g/L LL', 'U/L HH', 'mmol/L lo', 'mmol/L Hi', 'mg/dL (A)', 'U/L ABN', 'abnormal', 'mmol/L crit',
  'normal', 'Trace', 'negative', 'undetected', 'mmol/L N', 'g/L (low)',
  'mmol/L wysoki', 'U/L niski', 'dodatni', 'ujemny', 'mmol/L hoch', 'U/L niedrig', 'positiv', 'negativ',
  'mg/dL alto', 'mg/dL (bajo)', 'positivo', 'negativo', 'g/L baixo',
  // US-21 AC11: a denylist never ends, so words pass only as unit atoms. Each
  // of these passed the round-2 list.
  'Elevated', 'Raised', 'Critical', 'borderline', 'equivocal', 'erhöht', 'erniedrigt', 'nachweisbar',
  'podwyższony', 'obniżony', 'pozytywny', 'wykryto', 'nieprawidłowy', 'elevado', 'aumentado', 'reactivo',
  'detectado', 'reagente', 'não reagente', 'pos.', 'neg.', 'H.', 'mmol/L-H', 'mmol/L·H', 'mmol/L HIGH.',
  '-', '--', 'mmol/L -', 'mmol/L L', 'U/L (s)', 'g/L s',
  // A German lab flags low with a dash; a unit never starts or ends with one.
  'mmol/L-', '-mmol/L', 'mmol/L+', 'g/dL (-)',
];
const UNIT_SPELLINGS = [
  'mmol/L', '10^9/L', 'x10^9/L', '×10⁹/L', 'mL/min/1.73m²', 'tys/µl', 'mln/µl',
  'g/dL', '%', 'U/L', 'µmol/L', 'pg/mL', 'mL/min/1.73 m²', '10^12/L', 'Unit(s)',
  '10^3/µL', '10^6/µL', '×10³/mm3', 'mL/min/1.73m2', 'mg/24h', '/100 WBC', '10E9/L',
  'x10^4/µL', '10^5/µL', '×10³/µl', '×10¹²/L', '×10⁶/µl', 'ml/min/1.73 m²', 'ml/min/1.73',
  '10*3/µL', 'x10^12/L', '10^4', 'cells/mm³', 'mg/24 h', 'g/24hr',
  // Words that hold a flag word inside them are not flags: only whole tokens are.
  'µg/L FEU', 'ng/mL (FEU)', 'Index', 'ratio', 'mIU/L', 'Lymphs/100 WBC', 'Unit(s)',
  // US-21 AC11: count spellings from Polish, German and US reports, built of unit atoms.
  'tys/µl', 'mln/µl', 'Tsd/µl', 'Mio/µl', 'K/uL', 'thou/mm3', 'cells/cmm', 'mL/min/1.73 m²', '10^9/L',
  '×10³/µL', 'mg/24 h', 'mmol/mol', 'Gpt/l', 'mOsm/kg', 'µkat/L', 'células/µL', 'komórek/µl', 'Zellen/µl',
  'UI/L', 'mUI/mL', 'mEq/L', 'kU/L', 'mm/h', 'sec', 'mmHg', 'kPa', '/hpf', 'X10^9/L', 'μmol/L',
];

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
      'reminder_email_clicked',
    ] as const) {
      await recordServerEvent(eventName);
    }
    expect(inserts.map((row) => row.event_name)).toEqual([
      'report_email_sent',
      'report_email_clicked',
      'report_email_complained',
      'report_email_bounced',
      'reminder_email_clicked',
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
    expect(inserts[0]?.metadata).not.toHaveProperty('reason');
  });

  /**
   * US-32 AC34. Two vocabularies, one `reason` column. A word from the wrong
   * list would validate and then split every funnel query in two — the row
   * counts, the breakdown reads zero — so the pairing is checked per event.
   */
  it('holds each `reason` word to the event that may carry it', async () => {
    await recordServerEvent('mcp_tool_call', { tool: 'add_measurement', outcome: 'refused', reason: 'no-cookie' as never });
    await recordServerEvent('mcp_authorize_refused', { client: 'claude', reason: 'slot-occupied' as never });
    expect(inserts.map((row) => row.metadata)).toEqual([
      { tool: 'add_measurement', outcome: 'refused' },
      { client: 'claude' },
    ]);
  });

  it('keeps the word each OAuth event does own, `/token`\'s included', async () => {
    await recordServerEvent('mcp_authorize_refused', { client: 'claude', reason: 'unknown-client' });
    await recordServerEvent('mcp_connect_failed', { client: 'claude', provider: 'dropbox', reason: 'exchange-failed' });
    // The `/token` words, the last door: same list, same event, one per exit.
    await recordServerEvent('mcp_connect_failed', { reason: 'token-bad-request' });
    await recordServerEvent('mcp_connect_failed', { client: 'claude', reason: 'token-grant-type' });
    await recordServerEvent('mcp_connect_failed', { client: 'claude', reason: 'token-dead-code' });
    await recordServerEvent('mcp_connect_failed', { client: 'other', provider: 'dropbox', reason: 'token-client' });
    await recordServerEvent('mcp_connect_failed', { client: 'claude', provider: 'dropbox', reason: 'token-redirect' });
    await recordServerEvent('mcp_connect_failed', { client: 'claude', provider: 'dropbox', reason: 'token-pkce' });
    await recordServerEvent('mcp_connect_failed', { client: 'claude', provider: 'dropbox', reason: 'token-replayed' });
    await recordServerEvent('mcp_connect_failed', { client: 'claude', reason: 'token-dead-refresh' });
    expect(inserts.map((row) => (row.metadata as { reason?: string } | null)?.reason)).toEqual([
      'unknown-client', 'exchange-failed', 'token-bad-request', 'token-grant-type', 'token-dead-code',
      'token-client', 'token-redirect', 'token-pkce', 'token-replayed', 'token-dead-refresh',
    ]);
    expect(inserts[1]?.metadata).toEqual({ client: 'claude', provider: 'dropbox', reason: 'exchange-failed' });
  });

  it('refuses a `/token` word on the tool counter, which draws from the other list', async () => {
    await recordServerEvent('mcp_tool_call', { tool: 'add_measurement', outcome: 'refused', reason: 'token-pkce' as never });
    expect(inserts[0]?.metadata).toEqual({ tool: 'add_measurement', outcome: 'refused' });
  });

  it('drops an undeclared key before the insert', async () => {
    await recordServerEvent('mcp_connect', { foo: 'bar' } as never);
    expect(JSON.stringify(inserts)).not.toContain('foo');
    expect(inserts[0]?.metadata).toBeNull();
  });

  // US-32 AC29 counts an unrecognised refusal as `other` and KEEPS the row.
  // The backstop must not be harsher than the rule it backs up: one bad key
  // costs its own key, never tool/client/outcome, which product-health reads.
  it('strips only the offending key and keeps the rest of the breakdown', async () => {
    await recordServerEvent('mcp_tool_call', {
      tool: 'correct_value', client: 'claude', outcome: 'refused', reason: 'made-up-word',
    } as never);
    expect(inserts[0]?.metadata).toEqual({ tool: 'correct_value', client: 'claude', outcome: 'refused' });
    expect(captureMessage.mock.calls[0][1].extra).toEqual({ eventName: 'mcp_tool_call', keys: ['reason'] });
  });

  it('refuses a row whose event name is not on the list, and says so without a value', async () => {
    await recordServerEvent('not_an_event' as never, { client: 'claude' });
    expect(inserts).toHaveLength(0);
    expect(captureMessage.mock.calls[0][0]).toBe('product_events: event refused');
  });

  // The report exists so a misbehaving caller is visible. It must name the
  // KEYS and never the value: the value is the thing we refused to store.
  it('reports a rejection by key name, never by value', async () => {
    await recordServerEvent('mcp_connect', { ldl: '4.2 mmol/L' } as never);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessage.mock.calls[0];
    expect(message).toBe('product_events: server metadata keys dropped');
    expect(options).toMatchObject({ level: 'warning', tags: { feature: 'product_events' } });
    expect(options.extra).toEqual({ eventName: 'mcp_connect', keys: ['ldl'] });
    expect(JSON.stringify(options)).not.toContain('4.2');
  });

  it('reports nothing when the metadata is clean', async () => {
    await recordServerEvent('mcp_connect', { client: 'claude', provider: 'dropbox' });
    expect(captureMessage).not.toHaveBeenCalled();
  });

  // US-32 AC38: the reviewer sign-in's usage signal. `via` is owned by
  // `mcp_connect` alone; unregistered, cleanMetadata would strip it silently
  // and keep the row, so this asserts what is STORED.
  it('stores `via: reviewer` on mcp_connect, and refuses it on every other event', async () => {
    await recordServerEvent('mcp_connect', { client: 'chatgpt', provider: 'dropbox', via: 'reviewer' });
    await recordServerEvent('mcp_connect_failed', { client: 'chatgpt', reason: 'reviewer-credentials', via: 'reviewer' } as never);
    await recordServerEvent('mcp_tool_call', { tool: 'read_record', client: 'chatgpt', outcome: 'ok', via: 'reviewer' } as never);
    await recordServerEvent('mcp_connect', { client: 'chatgpt', via: 'someone' } as never);
    expect(inserts.map((row) => row.metadata)).toEqual([
      { client: 'chatgpt', provider: 'dropbox', via: 'reviewer' },
      { client: 'chatgpt', reason: 'reviewer-credentials' },
      { tool: 'read_record', client: 'chatgpt', outcome: 'ok' },
      { client: 'chatgpt' },
    ]);
  });

  // US-36 AC9: the two-phase usage signal. `step` is owned by `mcp_tool_call` alone.
  it('stores `step` on mcp_tool_call, and refuses it on every other event', async () => {
    await recordServerEvent('mcp_tool_call', { tool: 'correct_value', client: 'chatgpt', outcome: 'ok', step: 'propose' });
    await recordServerEvent('mcp_tool_call', { tool: 'correct_value', client: 'chatgpt', outcome: 'ok', step: 'confirm' });
    await recordServerEvent('mcp_connect', { client: 'chatgpt', provider: 'dropbox', step: 'confirm' } as never);
    await recordServerEvent('mcp_tool_call', { tool: 'correct_value', client: 'chatgpt', outcome: 'ok', step: 'other' } as never);
    expect(inserts.map((row) => row.metadata)).toEqual([
      { tool: 'correct_value', client: 'chatgpt', outcome: 'ok', step: 'propose' },
      { tool: 'correct_value', client: 'chatgpt', outcome: 'ok', step: 'confirm' },
      { client: 'chatgpt', provider: 'dropbox' },
      { tool: 'correct_value', client: 'chatgpt', outcome: 'ok' },
    ]);
  });

  it('keeps the three reviewer reasons on mcp_connect_failed (US-32 AC38)', async () => {
    await recordServerEvent('mcp_connect_failed', { client: 'chatgpt', provider: 'dropbox', reason: 'reviewer-credentials' });
    await recordServerEvent('mcp_connect_failed', { client: 'chatgpt', provider: 'dropbox', reason: 'reviewer-rate-limited' });
    await recordServerEvent('mcp_connect_failed', { client: 'chatgpt', provider: 'dropbox', reason: 'reviewer-generation' });
    expect(inserts.map((row) => (row.metadata as { reason?: string }).reason)).toEqual([
      'reviewer-credentials', 'reviewer-rate-limited', 'reviewer-generation',
    ]);
  });

  // US-21 phase 3, the same pairing on the server path, where a bad key is
  // pruned rather than costing the row: the counter still counts.
  it('keeps the refused key and unit, and prunes them off any other event', async () => {
    await recordServerEvent('lab_unit_refused', { key: 'ldl_cholesterol', unit: 'mg/dL' });
    await recordServerEvent('lab_unit_refused', { key: 'ldl_cholesterol', unit: '4.2' } as never);
    await recordServerEvent('lab_row_added', { key: 'ldl_cholesterol', unit: 'mg/dL' } as never);
    expect(inserts.map((row) => row.metadata)).toEqual([
      { key: 'ldl_cholesterol', unit: 'mg/dL' },
      { key: 'ldl_cholesterol' },
      null,
    ]);
    expect(JSON.stringify(inserts)).not.toContain('4.2');
  });

  it('prunes a unit with a value inside it, keeping the count (US-21 phase 3)', async () => {
    for (const unit of NUMBER_IN_UNIT) await recordServerEvent('lab_unit_refused', { key: 'ldl_cholesterol', unit });
    expect(inserts.map((row) => row.metadata)).toEqual(NUMBER_IN_UNIT.map(() => ({ key: 'ldl_cholesterol' })));
  });

});

/**
 * US-21 phase 3 — the refused-unit counter. It says which catalogue key and
 * which unit spelling to add next, and nothing else: a bare number is what a
 * health value would arrive as, and no unit is spelled that way.
 */
describe('the refused-unit counter', () => {
  it('keeps the catalogue key and the unit spelling', () => {
    expect(
      parseProductEvent({
        eventName: 'lab_unit_refused',
        visitorId: VISITOR,
        metadata: { key: 'ldl_cholesterol', unit: 'mg/dL' },
      }),
    ).toMatchObject({ metadata: { key: 'ldl_cholesterol', unit: 'mg/dL' } });
  });

  it('refuses a unit that is really a number — the shape a value arrives in', () => {
    for (const unit of ['4.2', '0', '1e3', ' 4.2 ']) {
      expect(
        parseProductEvent({
          eventName: 'lab_unit_refused',
          visitorId: VISITOR,
          metadata: { key: 'ldl_cholesterol', unit },
        }),
        unit,
      ).toBeNull();
    }
  });

  it('refuses a unit with a value or a result flag inside it (US-21 phase 3, AC11)', () => {
    for (const unit of NUMBER_IN_UNIT) {
      expect(isLabUnitWord(unit), unit).toBe(false);
      expect(
        parseProductEvent({ eventName: 'lab_unit_refused', visitorId: VISITOR, metadata: { key: 'ldl_cholesterol', unit } }),
        unit,
      ).toBeNull();
    }
  });

  it('keeps real unit spellings, eGFR\'s 1.73 m² included (US-21 phase 3)', () => {
    for (const unit of UNIT_SPELLINGS) {
      expect(isLabUnitWord(unit), unit).toBe(true);
      expect(
        parseProductEvent({ eventName: 'lab_unit_refused', visitorId: VISITOR, metadata: { key: 'egfr', unit } }),
        unit,
      ).toMatchObject({ metadata: { key: 'egfr', unit } });
    }
  });

  it('keeps every unit spelling the lab catalogue and UNIT_DEFS accept (US-21 phase 3, AC11)', () => {
    const spellings = new Set([...CATALOG_UNITS, ...Object.values(UNIT_DEFS).flatMap((def) => [def.canonical, def.label.si, def.label.conventional]), ...LAB_CATALOG.flatMap((entry) => [
      ...acceptedLabUnits(entry), ...(entry.nameConversions ?? []).flatMap((named) => Object.keys(named.conversions)),
    ])]);
    expect(spellings.size).toBeGreaterThan(40);
    expect([...spellings].filter((unit) => !isLabUnitWord(unit))).toEqual([]);
  });

  it('refuses a key that is not a catalogue word', () => {
    expect(
      parseProductEvent({
        eventName: 'lab_unit_refused',
        visitorId: VISITOR,
        metadata: { key: 'LDL is 4.2 mmol/L', unit: 'mmol/L' },
      }),
    ).toBeNull();
  });

  it('lets no other event carry a key or a unit', () => {
    for (const metadata of [{ key: 'ldl_cholesterol' }, { unit: 'mg/dL' }]) {
      expect(
        parseProductEvent({ eventName: 'lab_row_added', visitorId: VISITOR, metadata }),
        JSON.stringify(metadata),
      ).toBeNull();
    }
  });
});

/** US-05 AC2 — the Lp(a) unit counter: which unit was chosen, and from which. */
describe('the Lp(a) unit counter', () => {
  it('takes the two unit labels, from a browser', () => {
    expect(parseProductEvent({ eventName: 'lpa_unit_selected', visitorId: VISITOR, metadata: { unit: 'mg/dL', from: 'nmol/L' } }))
      .toEqual({ eventName: 'lpa_unit_selected', visitorId: VISITOR, metadata: { unit: 'mg/dL', from: 'nmol/L' } });
  });

  it('refuses a label that is not an Lp(a) unit, a number, or any other key', () => {
    for (const metadata of [
      { unit: 'mmol/L', from: 'nmol/L' }, { unit: 'mg/dL', from: '75' }, { unit: '30', from: 'mg/dL' },
      { unit: 'mg/dL', from: 'nmol/L', count: 1 }, { unit: 'mg/dL', from: 'nmol/L', value: 30 }, { unit: 'mg/dL', from: 'nmol/L', key: 'lpa' },
    ]) {
      expect(parseProductEvent({ eventName: 'lpa_unit_selected', visitorId: VISITOR, metadata }), JSON.stringify(metadata)).toBeNull();
    }
  });

  it('lets no other event carry a from', () => {
    expect(parseProductEvent({ eventName: 'lab_unit_refused', visitorId: VISITOR, metadata: { key: 'ldl_cholesterol', unit: 'mg/dL', from: 'mg/dL' } })).toBeNull();
    expect(parseProductEvent({ eventName: 'lab_row_added', visitorId: VISITOR, metadata: { from: 'mg/dL' } })).toBeNull();
  });
});

/** US-05 AC3 — the Lp(a) check: which answer the user gave, a label only. */
describe('the Lp(a) check counter', () => {
  it('takes the answer, one of mg/dL, nmol/L, mg/L and keep, from a browser', () => {
    for (const answer of ['mg/dL', 'nmol/L', 'mg/L', 'keep']) {
      expect(parseProductEvent({ eventName: 'lpa_check_answered', visitorId: VISITOR, metadata: { answer } }))
        .toEqual({ eventName: 'lpa_check_answered', visitorId: VISITOR, metadata: { answer } });
    }
  });

  it('refuses another word, a number, or any other key', () => {
    for (const metadata of [
      { answer: 'mg/l' }, { answer: 'mmol/L' }, { answer: '156' }, { answer: 390 },
      { answer: 'mg/dL', value: 390 }, { answer: 'mg/dL', count: 1 }, { answer: 'mg/dL', unit: 'mg/dL' },
    ]) {
      expect(parseProductEvent({ eventName: 'lpa_check_answered', visitorId: VISITOR, metadata }), JSON.stringify(metadata)).toBeNull();
    }
  });

  it('lets no other event carry an answer', () => {
    expect(parseProductEvent({ eventName: 'lpa_unit_selected', visitorId: VISITOR, metadata: { unit: 'mg/dL', from: 'nmol/L', answer: 'mg/dL' } })).toBeNull();
    expect(parseProductEvent({ eventName: 'correction_made', visitorId: VISITOR, metadata: { answer: 'mg/dL' } })).toBeNull();
  });
});

describe('the upload outcome counter (US-12 AC10)', () => {
  const counts = { picked: 9, withValues: 6, documentOnly: 1, noValues: 0, openFailed: 1, tooLarge: 1, truncated: 1, serverError: 0, limitError: 0, refused: 1, tooLong: 1, valuesDropped: 3, docx: 1, picturesOnly: 1, undatedPrevious: 4 };

  it('takes integer counts from a browser', () => {
    expect(parseProductEvent({ eventName: 'upload_outcome', visitorId: VISITOR, metadata: counts }))
      .toMatchObject({ metadata: counts });
  });

  it('refuses a string, a negative, a fraction, a count over 1000 and a value-shaped field', () => {
    for (const metadata of [
      { picked: '9' }, { openFailed: -1 }, { withValues: 1.5 }, { tooLarge: 1001 }, { valuesDropped: 1001 }, { docx: 1.5 }, { docx: 'docx' }, { undatedPrevious: 1.5 }, { undatedPrevious: -1 }, { undatedPrevious: 'undated' },
      { picked: 1, fileName: 'report.pdf' }, { picked: 1, unit: 'mmol/L' }, { picked: 1, value: 4.2 },
    ]) {
      expect(
        parseProductEvent({ eventName: 'upload_outcome', visitorId: VISITOR, metadata }),
        JSON.stringify(metadata),
      ).toBeNull();
    }
  });

  it('refuses every other metadata key, even one another event may carry', () => {
    for (const metadata of [
      { picked: 1, provider: 'google-drive' }, { picked: 1, count: 1 }, { picked: 1, outcome: 'ok' },
      { picked: 1, tool: 'get_plan' }, { picked: 1, backend: 'local' }, { picked: 1, placement: 'header' },
    ]) {
      expect(
        parseProductEvent({ eventName: 'upload_outcome', visitorId: VISITOR, metadata }),
        JSON.stringify(metadata),
      ).toBeNull();
    }
  });

  it('lets no other event carry an outcome count', () => {
    for (const key of Object.keys(counts)) {
      expect(
        parseProductEvent({ eventName: 'upload_saved', visitorId: VISITOR, metadata: { [key]: 1 } }),
        key,
      ).toBeNull();
    }
  });
});
