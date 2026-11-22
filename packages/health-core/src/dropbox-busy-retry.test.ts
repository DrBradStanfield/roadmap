// US-14 AC5 (2026-11-23): an original Dropbox refuses as busy (409 `too_many_write_operations`, or 429) is tried at most
// twice more, each through the caller's own write, so its erase check runs again first. Any other refusal is tried
// once. Synthetic HTTP, an injected jitter source and a fake clock; no live provider, no real waits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFile } from './roadmap-file';
import { saveDocuments, type DocumentPayload, type DocumentSaveIO } from './document-save';
import { dropboxUploadDocument } from './dropbox-rest';

type Bytes = Uint8Array<ArrayBuffer>;
const NOW = '2026-02-01T00:00:00.000Z';
const BUSY_409 = () => new Response(JSON.stringify({ error_summary: 'path/too_many_write_operations/..' }), { status: 409, headers: { 'Retry-After': '2' } });
const BUSY_429 = () => new Response(JSON.stringify({ error_summary: 'too_many_requests/..' }), { status: 429 });
const FULL_409 = () => new Response(JSON.stringify({ error_summary: 'path/insufficient_space/..' }), { status: 409 });
const OK = () => new Response('{}', { status: 200 });

/** Each upload gets the next answer, the last repeating; `onCall` runs as it is asked. */
function provider(answers: Array<() => Response>, onCall: (n: number) => void = () => {}) {
  let n = 0;
  const fetchMock = vi.fn(() => { onCall(++n); return Promise.resolve(answers[Math.min(n - 1, answers.length - 1)]()); });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const letter = (title: string, documentType: DocumentPayload<Bytes>['documentType'] = 'clinic_letter'): DocumentPayload<Bytes> => ({
  documentType, title, documentDate: '2026-01-01', contentMd: '', metadata: {}, sourceFileName: `${title}.pdf`, file: new TextEncoder().encode(title),
});
/** Letters saved through Dropbox; `stopped` is the caller's erase check, which the engine asks before every attempt. */
function save(over: Partial<DocumentSaveIO<Bytes>> = {}, payloads = [letter('Synthetic letter')]) {
  let n = 0;
  const io: DocumentSaveIO<Bytes> = {
    hash: async (b) => `sha256-${new TextDecoder().decode(b)}`,
    write: (ref, bytes) => dropboxUploadDocument('token', ref, bytes), stopped: () => false,
    mimeType: () => 'application/pdf', now: () => NOW, newId: () => `doc-${++n}`, makesFolders: true, random: () => 0, ...over,
  };
  return saveDocuments(createEmptyFile({ deviceId: 'd', now: NOW }), payloads, io);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('a busy Dropbox refusal is tried again (US-14 AC5)', () => {
  it('refused once, then accepted: stored after the Retry-After wait, with one retry', async () => {
    const fetchMock = provider([BUSY_409, OK]);
    const done = save();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const plan = await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(plan.unstored).toBe(0);
    expect(plan.saved[0].fileRef).toBe('Clinic letters/2026-01-01 Synthetic letter.pdf');
  });

  it('refused twice, then accepted: stored, three attempts', async () => {
    const fetchMock = provider([BUSY_429, BUSY_429, OK]);
    const done = save();
    await vi.runAllTimersAsync();
    expect((await done).unstored).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refused every time: unstored after exactly three attempts; the waits grow, with jitter, through the injected timer', async () => {
    const fetchMock = provider([BUSY_429]);
    const waits: number[] = [];
    const plan = await save({ random: () => 0.5, sleep: async (ms) => { waits.push(ms); } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(plan.unstored).toBe(1);
    expect(plan.saved[0].fileRef).toBe('');
    expect(waits).toEqual([625, 1250]); // 0.5 s then 1 s, each with a quarter more of jitter at random 0.5
  });

  it('never early: Retry-After 4 twice is two attempts, one 4 s wait, then not stored (a second 4 s wait would pass 5 s)', async () => {
    const fetchMock = provider([() => new Response('{}', { status: 429, headers: { 'Retry-After': '4' } })]);
    const waits: number[] = [];
    const plan = await save({ sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([4000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(plan.unstored).toBe(1);
  });

  it('any other refusal (a full Dropbox, a 500): one attempt', async () => {
    for (const answer of [FULL_409, () => new Response('', { status: 500 })]) {
      const fetchMock = provider([answer, OK]);
      const done = save();
      await vi.runAllTimersAsync();
      expect((await done).unstored).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('an erase landing between the refusal and the retry: no second write', async () => {
    let erased = false;
    const fetchMock = provider([BUSY_409, OK], () => { erased = true; });
    const done = save({ stopped: () => erased });
    await vi.runAllTimersAsync();
    expect((await done).unstored).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('three first writes at once, two refused once: all three end stored', async () => {
    const seen = new Map<string, number>();
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit = {}) => {
      const path = (JSON.parse(new Headers(init.headers).get('Dropbox-API-Arg') ?? '{}') as { path: string }).path;
      const n = (seen.get(path) ?? 0) + 1;
      seen.set(path, n);
      peak = Math.max(peak, ++inFlight);
      const refuse = n === 1 && !path.startsWith('/Scans');
      return new Promise<Response>((r) => setTimeout(() => { inFlight--; r(refuse ? BUSY_409() : OK()); }, 10));
    });
    vi.stubGlobal('fetch', fetchMock);
    const done = save({}, [letter('Letter A'), letter('Letter B', 'other'), letter('Scan C', 'scan_result')]);
    await vi.runAllTimersAsync();
    const plan = await done;
    expect(peak).toBe(3);
    expect(plan.unstored).toBe(0);
    expect(plan.saved.map((d) => d.fileRef)).toEqual(['Clinic letters/2026-01-01 Letter A.pdf', 'Other documents/2026-01-01 Letter B.pdf', 'Scans/2026-01-01 Scan C.pdf']);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
