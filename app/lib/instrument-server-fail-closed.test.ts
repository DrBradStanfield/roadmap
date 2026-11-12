import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

// US-09 AC7i: a server scrub hook that throws sends nothing. The production
// options (instrument.server.mjs) go through the real SDK with a capturing
// transport; the shared scrub throws or returns null on demand, so the throw
// happens inside our hooks.
vi.mock('@sentry/react-router', async (original) => ({
  ...await original<typeof import('@sentry/react-router')>(), init: vi.fn(),
}));
const mode = vi.hoisted(() => ({ throw: null as unknown, drop: false, outputs: [] as unknown[], crumbThrow: null as unknown }));
vi.mock('../../instrument-scrub.mjs', async (original) => {
  const real = await original<Record<string, any>>();
  return {
    ...real,
    scrubBreadcrumbData: (data: unknown) => {
      if (mode.crumbThrow !== null) throw mode.crumbThrow;
      return real.scrubBreadcrumbData(data);
    },
    scrubServerEvent: (event: unknown) => {
      if (mode.throw !== null) throw mode.throw;
      if (mode.drop) return null;
      const out = real.scrubServerEvent(event);
      mode.outputs.push(out);
      return out;
    },
  };
});

const SENTINEL = 'MSG_SENTINEL_9a3f';
const FIXED = (name: string) => `Sentry scrub failed (${name}); event dropped`;
type Item = [{ type: string }, Record<string, any>];
const envelopes: Array<[unknown, Item[]]> = [];
const items = () => envelopes.flatMap(([, list]) => list);
// A client report holds counts and reasons only (no event content); every
// other item is content the SDK sent.
const content = () => items().filter(([h]) => h.type !== 'client_report');
const discarded = () => items().filter(([h]) => h.type === 'client_report')
  .flatMap(([, p]) => p.discarded_events as Array<{ category: string; reason: string }>);
async function settle(until: () => void) {
  await vi.waitFor(async () => { await Sentry.flush(100); until(); }, { timeout: 2000 });
}
const internalCaptures: unknown[] = [];
let errorLog: ReturnType<typeof vi.spyOn>;

/** A TypeError whose `name` getter throws, or whose name is a Symbol. */
function oddError(kind: 'getter' | 'symbol') {
  const error = new TypeError(`odd error ${SENTINEL}`);
  if (kind === 'getter') Object.defineProperty(error, 'name', { get() { throw new Error(`name getter ${SENTINEL}`); } });
  else Object.defineProperty(error, 'name', { value: Symbol(SENTINEL) });
  return error;
}

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
  mode.crumbThrow = null;
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
    expect(content()).toEqual([]);
    expect(JSON.stringify(items())).not.toContain(SENTINEL);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[FIXED('TypeError')]]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SENTINEL);
  });

  it('beforeSend: a thrown non-Error is named by its type', async () => {
    mode.throw = `thrown string ${SENTINEL}`;
    Sentry.captureException(new Error('probe string throw'));
    await Sentry.flush(500);
    expect(content()).toEqual([]);
    expect(JSON.stringify(items())).not.toContain(SENTINEL);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[FIXED('string')]]);
  });

  it.each([
    ['a name getter that throws', () => oddError('getter'), [[FIXED('unknown')]]],
    ['a Symbol name', () => oddError('symbol'), [[FIXED('unknown')]]],
  ])('beforeSend: an error with %s still returns null and sends nothing', async (_label, make, lines) => {
    mode.throw = make();
    const hook = Sentry.getClient()!.getOptions().beforeSend!;
    expect(hook({ message: 'direct' } as Sentry.ErrorEvent, {})).toBeNull();
    Sentry.captureException(new Error(`probe odd error: ${_label}`));
    await Sentry.flush(500);
    expect(content()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([...lines, ...lines]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SENTINEL);
  });

  it('beforeSend: a console.error that throws still returns null and sends nothing', async () => {
    mode.throw = failing();
    errorLog.mockImplementation(() => { throw new Error('console broke'); });
    const hook = Sentry.getClient()!.getOptions().beforeSend!;
    expect(hook({ message: 'direct' } as Sentry.ErrorEvent, {})).toBeNull();
    Sentry.captureException(new Error('probe console throw'));
    await Sentry.flush(500);
    expect(content()).toEqual([]);
    expect(internalCaptures).toEqual([]);
  });

  it('beforeSendTransaction: a throw sends no envelope and no internal event', async () => {
    mode.throw = failing();
    Sentry.startSpan({ name: `tx ${SENTINEL}` }, () => {});
    await settle(() => expect(discarded()).toContainEqual(expect.objectContaining({ category: 'transaction', reason: 'before_send' })));
    expect(content()).toEqual([]);
    expect(JSON.stringify(items())).not.toContain(SENTINEL);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[FIXED('TypeError')]]);
  });

  it('beforeBreadcrumb: a throw drops the crumb, nothing crashes and nothing unscrubbed is sent', async () => {
    mode.crumbThrow = failing();
    // An outgoing call's crumb: addBreadcrumb has no catch of its own, so a throw here would reach its caller.
    expect(() => Sentry.addBreadcrumb({ category: 'http', data: { url: `https://example.invalid/${SENTINEL}` } })).not.toThrow();
    expect(errorLog.mock.calls).toEqual([[FIXED('TypeError')]]);
    mode.crumbThrow = null;
    Sentry.captureException(new Error('probe after crumb'));
    await settle(() => expect(content().map(([h]) => h.type)).toEqual(['event']));
    expect(JSON.stringify(items())).not.toContain(SENTINEL);
    expect(internalCaptures).toEqual([]);
  });

  it('a hook that returns normally sends the same scrubbed event as before', async () => {
    Sentry.captureException(new Error('My LDL is 3.2 mmol/L'));
    Sentry.startSpan({ name: 'tx-unchanged' }, () => {});
    await settle(() => expect(content().map(([h]) => h.type).sort()).toEqual(['event', 'transaction']));
    const sent = content().map(([, payload]) => payload);
    // The very object each hook returned is what went out.
    for (const payload of sent) expect(mode.outputs).toContain(payload);
    // The message is scrubbed (stack frames keep their source lines, which quote this file).
    const [, event] = content().find(([h]) => h.type === 'event')!;
    expect(event.exception.values[0].value).not.toContain('3.2');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('SDK pin: a null from beforeSend sends nothing and creates no internal event', async () => {
    mode.drop = true;
    Sentry.captureException(new Error('probe null'));
    Sentry.startSpan({ name: 'tx-null' }, () => {});
    await settle(() => expect(discarded()).toContainEqual(expect.objectContaining({ category: 'transaction', reason: 'before_send' })));
    expect(content()).toEqual([]);
    expect(JSON.stringify(items())).not.toContain(SENTINEL);
    expect(internalCaptures).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
  });
});
