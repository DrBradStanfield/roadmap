import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

// US-09 AC7i: a server scrub hook that throws sends nothing. The production
// options (instrument.server.mjs) go through the real SDK with a capturing
// transport; the shared scrub throws or returns null on demand, so the throw
// happens inside our hooks.
vi.mock('@sentry/react-router', async (original) => ({
  ...await original<typeof import('@sentry/react-router')>(), init: vi.fn(),
}));
const mode = vi.hoisted(() => ({ throw: null as unknown, drop: false, outputs: [] as unknown[] }));
vi.mock('../../instrument-scrub.mjs', async (original) => {
  const real = await original<Record<string, any>>();
  return {
    ...real,
    scrubServerEvent: (event: unknown) => {
      if (mode.throw !== null) throw mode.throw;
      if (mode.drop) return null;
      const out = real.scrubServerEvent(event);
      mode.outputs.push(JSON.parse(JSON.stringify(out)));
      return out;
    },
  };
});

const SENTINEL = 'MSG_SENTINEL_9a3f';
const FIXED = (name: string) => `Sentry scrub failed (${name}); event dropped`;
type Item = [{ type: string }, Record<string, any>];
const envelopes: Array<[unknown, Item[]]> = [];
const items = () => envelopes.flatMap(([, list]) => list);
const internalCaptures: unknown[] = [];
let errorLog: ReturnType<typeof vi.spyOn>;

function failing() {
  const error = new TypeError(`scrub broke on ${SENTINEL}`);
  error.stack = `TypeError: scrub broke on ${SENTINEL}\n    at stack-${SENTINEL}`;
  return error;
}

beforeAll(async () => {
  await import('../../instrument.server.mjs');
  const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
  const { init } = await vi.importActual<typeof import('@sentry/react-router')>('@sentry/react-router');
  init({
    ...options,
    dsn: 'https://public@example.invalid/1',
    enabled: true,
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope as unknown as [unknown, Item[]]); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
  const client = Sentry.getClient()!;
  const capture = client.captureException.bind(client);
  vi.spyOn(client, 'captureException').mockImplementation((exception, hint, scope) => {
    if ((hint?.data as { __sentry__?: unknown } | undefined)?.__sentry__ === true) internalCaptures.push(exception);
    return capture(exception, hint, scope);
  });
});

beforeEach(() => {
  envelopes.length = 0;
  internalCaptures.length = 0;
  mode.throw = null;
  mode.drop = false;
  mode.outputs.length = 0;
  errorLog?.mockRestore();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  errorLog?.mockRestore();
  await Sentry.close();
});

describe('US-09 AC7i: a server scrub hook that throws sends nothing', () => {
  it('beforeSend: a throw sends no envelope and no internal event, and logs the error name only', async () => {
    mode.throw = failing();
    Sentry.captureException(new Error(`probe ${SENTINEL}`));
    await Sentry.flush(500);
    expect(items()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[FIXED('TypeError')]]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SENTINEL);
  });

  it('beforeSend: a thrown non-Error is named by its type', async () => {
    mode.throw = `thrown string ${SENTINEL}`;
    Sentry.captureException(new Error('probe string throw'));
    await Sentry.flush(500);
    expect(items()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[FIXED('string')]]);
  });

  it('beforeSendTransaction: a throw sends no envelope and no internal event', async () => {
    mode.throw = failing();
    Sentry.startSpan({ name: `tx ${SENTINEL}` }, () => {});
    await Sentry.flush(500);
    expect(items()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[FIXED('TypeError')]]);
  });

  it('a hook that returns normally sends the same scrubbed event as before', async () => {
    Sentry.captureException(new Error('My LDL is 3.2 mmol/L'));
    Sentry.startSpan({ name: 'tx-unchanged' }, () => {});
    await vi.waitFor(async () => {
      await Sentry.flush(100);
      expect(items().map(([h]) => h.type).sort()).toEqual(['event', 'transaction']);
    }, { timeout: 2000 });
    const sent = items().map(([, payload]) => payload);
    for (const payload of sent) expect(mode.outputs).toContainEqual(payload);
    expect(JSON.stringify(sent)).not.toContain('3.2');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('SDK pin: a null from beforeSend sends nothing and creates no internal event', async () => {
    mode.drop = true;
    Sentry.captureException(new Error('probe null'));
    Sentry.startSpan({ name: 'tx-null' }, () => {});
    await Sentry.flush(500);
    expect(items()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
  });
});
