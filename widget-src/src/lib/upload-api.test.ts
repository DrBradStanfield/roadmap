/**
 * The upload's server transport: one file's read through the app proxy, its body and how a
 * failed answer is read (health-core upload-failure.ts). Synthetic fixtures only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as z from '../../../packages/health-core/src/zod';
import { checkLabImportQuota, labImport } from './upload-api';
import { labImportPageSchema, labImportRequestSchema } from '../../../packages/health-core/src/validation';

const FILES = [{ fileName: 'a.pdf', pages: [{ type: 'image' as const, content: 'AAAA', mimeType: 'image/png' }] }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[];

/** Every call to the endpoint, with its parsed body. */
function stubFetch(reply: (call: Call) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return reply(call);
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('privacy: no file name in the request body', () => {
  const NAMED = [
    { fileName: 'Jane Citizen bloods.pdf', pages: [{ type: 'text' as const, content: 'one' }] },
    { fileName: 'labs.zip/Jane Citizen 2024.pdf', pages: [{ type: 'text' as const, content: 'two' }] },
  ];
  let raw: string[];
  beforeEach(() => {
    raw = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      raw.push(String(init?.body ?? ''));
      return jsonResponse({ success: true, data: { values: [] } });
    }));
  });

  // US-12 AC14, deploy order: the widget ships before the Fly server. The live
  // server's schemas, copied verbatim from 6a4c8902 (`git show
  // 6a4c8902:packages/health-core/src/validation.ts`), take `ownDates: true`
  // only, so the undated flag is a separate key that they strip.
  const liveSingleSchema = z.object({
    pages: z.array(labImportPageSchema).min(1).max(100),
    unitSystem: z.enum(['si', 'conventional']).optional(),
    ownDates: z.literal(true).optional(),
  });
  it('the body passes the LIVE server\'s schema (6a4c8902), which strips the undated flag; the new one keeps it', async () => {
    await labImport(NAMED[0].pages, 'si');
    const single = JSON.parse(raw[0]);
    const live = liveSingleSchema.safeParse(single);
    expect(live.success).toBe(true);
    expect(live.success && (live.data as Record<string, unknown>).undatedPrev).toBeUndefined();
    expect(live.success && live.data.ownDates).toBe(true);
    expect(labImportRequestSchema.parse(single).undatedPrev).toBe(true);
  });

  // US-12 AC12: `ownDates` tells the server this widget files a value on its own day.
  // US-12 AC14: `undatedPrev` tells it this widget asks for an undated previous column's date.
  it('the single-file path sends pages, the unit system, ownDates and undatedPrev only', async () => {
    await labImport(NAMED[0].pages, 'si');
    expect(JSON.parse(raw[0])).toEqual({ pages: NAMED[0].pages, unitSystem: 'si', ownDates: true, undatedPrev: true, refusedRows: true });
  });
});

// Privacy: a JSON body that fails to parse can be quoted by the SyntaxError,
// and the console must not carry it (the error's kind only, as BYOK logs).
describe('privacy: a failed upload response logs no body text', () => {
  it('logs neither the body nor the parse error message', async () => {
    stubFetch(() => new Response('{"data": SYNTHETIC sodium 141', { status: 200, headers: { 'content-type': 'application/json' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await labImport(FILES[0].pages, 'si');
    const logged = JSON.stringify(warn.mock.calls.map(c => c.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))));
    expect(logged).not.toContain('SYNTHETIC');
    expect(logged).not.toContain('141');
    warn.mockRestore();
  });
});

// US-15 AC34: the server answers 422 for a file Claude declined or stopped
// short on, with the code in the body; anything else not ok stays a server error.
describe('a file the server says stopped short', () => {
  it.each(['refused', 'too_long'] as const)('maps a 422 "%s" to its own code', async (code) => {
    stubFetch(() => jsonResponse({ success: false, error: 'Not read', errorCode: code }, 422));
    expect((await labImport(FILES[0].pages, 'si')).errorCode).toBe(code);
  });

  it('keeps any other failure, or an unknown code, a server error', async () => {
    stubFetch(() => jsonResponse({ success: false, error: 'Failed to process request' }, 500));
    expect((await labImport(FILES[0].pages, 'si')).errorCode).toBe('server_error');
    stubFetch(() => jsonResponse({ success: false, errorCode: 'something_else' }, 422));
    expect((await labImport(FILES[0].pages, 'si')).errorCode).toBe('server_error');
    stubFetch(() => new Response('<html>proxy error</html>', { status: 422 }));
    expect((await labImport(FILES[0].pages, 'si')).errorCode).toBe('server_error');
  });
});

// US-12 AC10 (review R1, adversary F1): only the server's own "no" is the daily
// limit. A failed preflight is not, so it is never named or counted as one.
describe('US-12 AC10: the quota preflight says why it refused', () => {
  it('a 200 that says allowed:false is the daily limit', async () => {
    stubFetch(() => jsonResponse({ allowed: false, remaining: 0 }));
    expect(await checkLabImportQuota()).toEqual({ allowed: false, remaining: 0, reason: 'quota' });
  });
  // Review R2 (adversary, Codex): a failed preflight is not the limit, so it passes, as a network error does; the POST enforces.
  it('a 5xx lets the upload proceed: the POST enforces the limit', async () => {
    stubFetch(() => jsonResponse({ error: 'x' }, 503));
    expect(await checkLabImportQuota()).toEqual({ allowed: true, remaining: 0 });
  });
  it('no answer at all (the request throws) lets the upload proceed too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await checkLabImportQuota()).allowed).toBe(true);
  });
  it('a 200 that allows passes the remaining count through', async () => {
    stubFetch(() => jsonResponse({ allowed: true, remaining: 12 }));
    expect(await checkLabImportQuota()).toEqual({ allowed: true, remaining: 12 });
  });
});

// US-12 AC9 (H65): a 429 says which with a code. Busy is not the daily limit;
// a missing or unknown code reads as the daily limit, as an older server meant.
describe('US-12 AC9 H65: a 429 is read by its code', () => {
  const DAILY = { error: 'Daily upload limit reached. You can upload more tomorrow.', errorCode: 'rate_limit' };
  const BUSY = { error: 'Server busy. Please try again later.', errorCode: 'busy' };
  const cases: Array<[string, () => Response, typeof DAILY]> = [
    ['code busy', () => jsonResponse({ success: false, error: 'Server busy. Please try again later.', code: 'busy' }, 429), BUSY],
    ['code daily_limit', () => jsonResponse({ success: false, error: 'Daily upload limit reached. You can upload more tomorrow.', code: 'daily_limit' }, 429), DAILY],
    ['no code', () => jsonResponse({ success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' }, 429), DAILY],
    ['an unknown code', () => jsonResponse({ success: false, error: 'x', code: 'later' }, 429), DAILY],
    ['no body', () => new Response(null, { status: 429 }), DAILY],
    ['a body that is not JSON', () => new Response('Too many', { status: 429, headers: { 'content-type': 'application/json' } }), DAILY],
  ];

  it.each(cases)('a single-file 429 with %s', async (_, reply, expected) => {
    stubFetch(reply);
    expect(await labImport(FILES[0].pages, 'si')).toEqual({ result: null, ...expected });
  });
});

// US-12 AC28: Cancel or Stop aborts a read in flight; the shared state ignores its late answer.
describe('US-12 AC28: a read takes the upload\'s signal', () => {
  it('hands fetch the signal, and an aborted read answers a network failure', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      seen = init?.signal ?? undefined;
      seen?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cancel = new AbortController();
    const read = labImport(FILES[0].pages, 'si', { signal: cancel.signal });
    await vi.waitFor(() => expect(seen).toBe(cancel.signal));
    cancel.abort();
    expect(await read).toEqual({ result: null, error: 'Network error', errorCode: 'network' });
  });
});
