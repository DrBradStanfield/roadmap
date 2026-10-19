/**
 * The poll client's half of the batch capability: the token the POST hands
 * back is kept here and presented on every poll. Without it the server answers
 * 404, so a client that forgets it never reads its own results.
 *
 * The poll is a POST with the token in the BODY. The server logs request URLs
 * to stdout, and a logged token reads the extracted lab text back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { labImport, labImportBatch, pollBatchStatus } from './upload-api';
import { batchImportRequestSchema, labImportPageSchema, labImportRequestSchema } from '../../../packages/health-core/src/validation';

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

describe('the batch poll carries the token the upload was given', () => {
  it('sends the pollToken in the body, never in the URL', async () => {
    stubFetch((call) =>
      call.body && 'batch' in call.body
        ? jsonResponse({ success: true, batchId: 'batch_abc', pollToken: 'tok-123' })
        : jsonResponse({ status: 'processing', completed: 0, total: 1 }));

    const { batchId } = await labImportBatch(FILES);
    expect(batchId).toBe('batch_abc');
    await pollBatchStatus('batch_abc');
    await pollBatchStatus('batch_abc');

    expect(calls.slice(1).map((c) => c.body)).toEqual([
      { batchId: 'batch_abc', pollToken: 'tok-123' },
      { batchId: 'batch_abc', pollToken: 'tok-123' },
    ]);
    // The URL is the bare endpoint — no query string to end up in a log line.
    for (const call of calls) {
      expect(call.url).not.toContain('?');
      expect(call.url).not.toContain('tok-123');
    }
  });

  it('polls a batch it never created with an empty token, and takes the 404 as a restart', async () => {
    stubFetch(() => jsonResponse({ error: 'Batch not found' }, 404));

    const poll = await pollBatchStatus('batch_stranger');
    expect(calls[0].body).toEqual({ batchId: 'batch_stranger', pollToken: '' });
    expect(poll).toMatchObject({ status: 'ended', errorCode: 'server_restart' });
  });
});

// Privacy: a file name can hold a patient's name ("Jane Citizen bloods.pdf").
// The server never needs it: a batch result comes back by its request index,
// and the browser maps the index to the file. So no name leaves the browser.
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
      return jsonResponse({ success: true, batchId: 'batch_abc', pollToken: 't', data: { values: [] } });
    }));
  });

  it('the batch sends each file\'s pages in order, and nothing that names it', async () => {
    await labImportBatch(NAMED);
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toContain('Jane');
    expect(raw[0]).not.toContain('.pdf');
    expect(raw[0]).not.toContain('.zip');
    expect(JSON.parse(raw[0])).toEqual({ batch: true, ownDates: true, undatedPrev: true, files: [
      { fileName: 'file-1', pages: NAMED[0].pages },
      { fileName: 'file-2', pages: NAMED[1].pages },
    ] });
  });

  // US-12 AC9, deploy order: CI ships the widget BEFORE the Fly server, and a
  // failed Fly step keeps the old server live. That server's schema (as of
  // 32f7b9c5) requires a fileName string on every batch file, so the widget
  // sends a placeholder label that names nothing. The new schema strips it.
  it('the batch body still passes the old server\'s schema, and the new one drops the label', async () => {
    const oldBatchSchema = z.object({
      batch: z.literal(true),
      files: z.array(z.object({
        fileName: z.string(),
        pages: z.array(labImportPageSchema).min(1).max(100),
      })).min(1).max(200),
    });
    await labImportBatch(NAMED);
    const body = JSON.parse(raw[0]);
    expect(oldBatchSchema.safeParse(body).success).toBe(true);
    const parsed = batchImportRequestSchema.parse(body);
    expect(parsed.files).toEqual([{ pages: NAMED[0].pages }, { pages: NAMED[1].pages }]);
    expect(parsed.ownDates).toBe(true); // US-12 AC12: this widget files a value on its own day
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
  const liveBatchSchema = z.object({
    batch: z.literal(true),
    files: z.array(z.object({
      pages: z.array(labImportPageSchema).min(1).max(100),
    })).min(1).max(200),
    ownDates: z.literal(true).optional(),
  });

  it('both bodies pass the LIVE server\'s schemas (6a4c8902), which strip the undated flag; the new ones keep it', async () => {
    await labImport(NAMED[0].pages, 'si');
    await labImportBatch(NAMED);
    const [single, batch] = raw.map(r => JSON.parse(r));
    const live = [liveSingleSchema.safeParse(single), liveBatchSchema.safeParse(batch)];
    expect(live.map(r => r.success)).toEqual([true, true]);
    expect(live.map(r => r.success && (r.data as Record<string, unknown>).undatedPrev)).toEqual([undefined, undefined]);
    expect(live.map(r => r.success && r.data.ownDates)).toEqual([true, true]);
    expect([labImportRequestSchema.parse(single).undatedPrev, batchImportRequestSchema.parse(batch).undatedPrev]).toEqual([true, true]);
  });

  // US-12 AC12: `ownDates` tells the server this widget files a value on its own day.
  // US-12 AC14: `undatedPrev` tells it this widget asks for an undated previous column's date.
  it('the single-file path sends pages, the unit system, ownDates and undatedPrev only', async () => {
    await labImport(NAMED[0].pages, 'si');
    expect(JSON.parse(raw[0])).toEqual({ pages: NAMED[0].pages, unitSystem: 'si', ownDates: true, undatedPrev: true });
  });
});

// Privacy: a JSON body that fails to parse can be quoted by the SyntaxError,
// and the console must not carry it (the error's kind only, as BYOK logs).
describe('privacy: a failed upload response logs no body text', () => {
  it('logs neither the body nor the parse error message, on one file and on a batch', async () => {
    stubFetch(() => new Response('{"data": SYNTHETIC sodium 141', { status: 200, headers: { 'content-type': 'application/json' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await labImport(FILES[0].pages, 'si');
    await labImportBatch(FILES);
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
