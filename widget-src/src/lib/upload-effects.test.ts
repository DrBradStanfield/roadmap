// The web's effects for the shared upload state (health-core upload-flow.ts): one pick driven
// through the real transition and the real effects, the transport and the record stubbed.
// US-12 AC1, AC7b, AC23, AC26-AC28. Synthetic names and values only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inFlight, type UploadState } from '@roadmap/health-core/upload-flow';
import type { HealthUploadAPI } from '../upload-entry';
import type { PageContent } from './api-types';
import { drive } from '../testing/upload-driver';
import { progressOf } from './upload-read';
import { FAIL_TEXT, OVER_LIMIT_TEXT } from '@roadmap/health-core/upload-text';
import { UPLOAD_LIMITS } from '@roadmap/health-core/upload-rules';

const pending = new Map<string, (ok: boolean) => void>();
const lab = { classification: 'lab_report', reportDate: null, values: [], additionalValues: [], document: null };
vi.mock('./upload-api', () => ({
  labImport: vi.fn((pages: PageContent[], _us: string, opts?: { signal?: AbortSignal }) => new Promise((resolve) => {
    opts?.signal?.addEventListener('abort', () => resolve({ result: null, error: 'Network error', errorCode: 'network' }));
    pending.set(pages[0].content, (ok) => resolve(ok ? { result: lab } : { result: null, error: 'Extraction failed', errorCode: 'server_error' }));
  })),
}));
const known = vi.hoisted(() => ({ hashes: new Set<string>(), archiveOnly: false, legacy: false }));
vi.mock('./roadmap-data', () => ({
  getDocumentArchiveMode: () => 'cloud',
  uploadKnownIndex: () => new Map([...known.hashes].map((h) => [h, { as: 'document', archiveOnly: known.archiveOnly }])),
  isLegacyUpload: () => known.legacy,
}));
// A fake hash that names the bytes it was given.
vi.mock('./archive-payloads', () => ({ sha256Blob: async (b: Blob) => `sha256-${await b.text()}` }));

const { labImport } = await import('./upload-api');

/** Every file opens as a PDF whose one page is its own bytes, so each send is answered by them. */
const upload = {
  isPdf: (f: File) => f.name.endsWith('.pdf'),
  isImage: () => false,
  extractFromPdf: vi.fn(async (file: File) => ({ pages: [{ type: 'text' as const, content: await file.text() }], truncated: false })),
  getZipEntries: vi.fn(),
} as unknown as HealthUploadAPI;
const pdf = (name: string) => new File([name], name, { type: 'application/pdf' });
const settle = async (n: number) => { for (let i = 0; i < 50 && pending.size < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const sending = (s: UploadState) => (s.phase === 'open' ? s.files.filter((f) => f.status.s === 'sending').length : 0);

beforeEach(() => { pending.clear(); known.hashes.clear(); known.archiveOnly = false; known.legacy = false; vi.mocked(labImport).mockClear(); });

describe('US-12 AC23: the review lists files in picked order (D12)', () => {
  it('later-picked files that finish first are still listed after the earlier ones, notices too', async () => {
    const names = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'];
    const run = drive(upload, names.map(pdf));
    await settle(names.length);
    // Answer last-picked first; two fail, and each keeps its place, its notice too.
    pending.get('d.pdf')!(false);
    pending.get('c.pdf')!(true);
    pending.get('b.pdf')!(false);
    pending.get('a.pdf')!(true);
    await vi.waitFor(() => expect(inFlight(run.state())).toBe(0));
    const { results, notices } = run.outcome();
    expect(results.map((r) => r.fileName)).toEqual(names);
    expect(results.map((r) => r.error)).toEqual([undefined, FAIL_TEXT.server, undefined, FAIL_TEXT.server]);
    expect(notices.filter((n) => n.reason === 'serverError').map((n) => n.name)).toEqual(['b.pdf', 'd.pdf']);
  });
});

describe('US-12 AC27: a file the record already holds is never sent', () => {
  it('is hashed, skipped before any read, and shown nowhere; the new file beside it is read', async () => {
    known.hashes.add('sha256-held.pdf');
    const run = drive(upload, [pdf('held.pdf'), pdf('new.pdf')]);
    await settle(1);
    pending.get('new.pdf')!(true);
    await vi.waitFor(() => expect(inFlight(run.state())).toBe(0));
    expect(vi.mocked(labImport).mock.calls.map(([pages]) => pages[0].content)).toEqual(['new.pdf']);
    expect(vi.mocked(upload.extractFromPdf).mock.calls.map(([f]) => (f as File).name)).not.toContain('held.pdf');
    const { results, notices } = run.outcome();
    expect(results.map((r) => r.fileName)).toEqual(['new.pdf']);
    expect(notices.map((n) => n.name)).not.toContain('held.pdf');
  });

  // Owner ruling 7 (mount 3b): one the record holds without its original is not read again either, with a cloud open:
  // the state holds it as known, `archiveOnly`, and the shared Save files its original unread (upload-plan.ts).
  it('one held without its original is never sent, with a cloud open; the state knows it as archive-only', async () => {
    known.hashes.add('sha256-held.pdf');
    known.archiveOnly = true;
    const run = drive(upload, [pdf('held.pdf'), pdf('new.pdf')]);
    await settle(1);
    pending.get('new.pdf')!(true);
    await vi.waitFor(() => expect(inFlight(run.state())).toBe(0));
    expect(vi.mocked(labImport).mock.calls.map(([pages]) => pages[0].content)).toEqual(['new.pdf']);
    const s = run.state();
    expect(s.phase === 'open' && s.files.map((f) => f.status)).toEqual([{ s: 'known', as: 'document', archiveOnly: true }, expect.objectContaining({ s: 'read' })]);
  });

  it('a read the record holds from before hashing (same name and date) is not offered either', async () => {
    known.legacy = true;
    vi.mocked(labImport).mockImplementationOnce(async () => ({ result: { ...lab, classification: 'clinic_letter', document: { classification: 'clinic_letter', title: 'Synthetic', documentDate: '2024-06-01', contentMarkdown: 'x', metadata: {} } } } as never));
    const run = drive(upload, [pdf('old letter.pdf')]);
    await vi.waitFor(() => expect(inFlight(run.state())).toBe(0));
    expect(run.outcome().results).toEqual([]);
  });
});

describe('US-12 AC26: 20 files or more take the same path, 5 sends at a time', () => {
  it('never sends more than 5 at once, and every file is read', async () => {
    const names = Array.from({ length: 24 }, (_, i) => `r${i}.pdf`);
    const run = drive(upload, names.map(pdf));
    // Answer one read at a time, oldest first, until every file is done.
    for (let i = 0; i < 500 && inFlight(run.state()) > 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const [first] = pending.keys();
      if (first) { pending.get(first)!(true); pending.delete(first); }
    }
    await vi.waitFor(() => expect(inFlight(run.state())).toBe(0));
    expect(Math.max(...run.states.map(sending))).toBe(5);
    expect(labImport).toHaveBeenCalledTimes(24);
    expect(run.outcome().results).toHaveLength(24);
  });
});

describe('US-12 AC1: progress counts a ZIP\'s members as each is read, never by a timer', () => {
  it('says the ZIP is opening, then counts its members done of all', async () => {
    vi.mocked(upload.getZipEntries).mockResolvedValueOnce(['m1.pdf', 'm2.pdf', 'm3.pdf'].map((name) => ({ name, entry: { async: async () => new Blob([name]) }, bytes: name.length })) as never);
    const run = drive(upload, [new File(['zip'], 'scans.zip', { type: 'application/zip' })]);
    expect(progressOf(run.state()).fileName).toBe('Opening scans.zip...');
    await settle(3);
    expect(progressOf(run.state())).toEqual({ current: 0, total: 100, fileName: 'm1.pdf' });
    pending.get('m1.pdf')!(true);
    await vi.waitFor(() => expect(progressOf(run.state()).fileName).toBe('Processed 1 of 3'));
    expect(progressOf(run.state()).current).toBe(33);
    pending.get('m2.pdf')!(true);
    pending.get('m3.pdf')!(true);
    await vi.waitFor(() => expect(progressOf(run.state()).fileName).toBe('Processed 3 of 3'));
    expect(run.outcome().results.map((r) => r.fileName)).toEqual(['scans.zip/m1.pdf', 'scans.zip/m2.pdf', 'scans.zip/m3.pdf']);
  });
});

describe('US-12 AC28: Stop aborts every read in flight; a late answer changes nothing', () => {
  it('aborts each send, and the files stay unread', async () => {
    const run = drive(upload, [pdf('a.pdf'), pdf('b.pdf')]);
    await settle(2);
    const signals = vi.mocked(labImport).mock.calls.map((c) => c[2]?.signal);
    run.send({ type: 'stop' });
    expect(signals.map((s) => s?.aborted)).toEqual([true, true]);
    pending.get('a.pdf')!(true);
    await new Promise((r) => setTimeout(r, 0));
    const s = run.state();
    expect(s.phase === 'open' && s.files.map((f) => f.status.s)).toEqual(['stopped', 'stopped']);
    expect(run.outcome().results).toEqual([]);
  });
});

describe('US-12 AC7b (U15): a read that passes the time limit', () => {
  const LIMIT_MS = 30_000;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  for (const kind of ['pdf', 'docx'] as const) {
    it(`a ${kind} read is told to stop at the limit, not before, and the file is listed as not opened`, async () => {
      const signals: AbortSignal[] = [];
      const hang = (signal: AbortSignal) => { signals.push(signal); return new Promise(() => {}); };
      const slow = {
        ...upload,
        extractFromPdf: vi.fn((_f: File, signal: AbortSignal) => hang(signal)),
        docxToText: vi.fn((_b: ArrayBuffer, signal: AbortSignal) => hang(signal)),
      } as unknown as HealthUploadAPI;
      const file = kind === 'pdf' ? pdf('slow.pdf') : new File(['x'], 'slow.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const run = drive(slow, [file]);
      await vi.advanceTimersByTimeAsync(LIMIT_MS - 1);
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted).toBe(true);
      expect(inFlight(run.state())).toBe(0);
      // The existing words: openFailed with no text of its own (UploadNotices).
      expect(run.outcome().notices).toEqual([{ name: file.name, reason: 'openFailed' }]);
      expect(labImport).not.toHaveBeenCalled();
    });
  }
});

// US-12 AC17, AC26 (adversary R3): a ZIP is read whole to list it, so few open at once; and one pick
// reads at most 200 files, its ZIPs' members included, as before the shared state.
describe('US-12 AC17: ZIPs open a few at a time, and a pick stops at 200 files', () => {
  it('10 ZIPs of 30 members: never more than the limit listed at once; members past 200 are named, never read', async () => {
    let open = 0;
    let most = 0;
    const listings: Array<() => void> = [];
    vi.mocked(upload.getZipEntries).mockImplementation(((zip: File) => {
      open++; most = Math.max(most, open);
      return new Promise((resolve) => listings.push(() => {
        open--;
        resolve(Array.from({ length: 30 }, (_, i) => ({ name: `${zip.name}-${i}.pdf`, entry: { async: async () => new Blob(['x']) }, bytes: 1 })));
      }));
    }) as never);
    const run = drive(upload, Array.from({ length: 10 }, (_, i) => new File(['zip'], `z${i}.zip`, { type: 'application/zip' })));
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 0));
      listings.shift()?.();
    }
    expect(most).toBe(UPLOAD_LIMITS.web.listsInFlight);
    const s = run.state();
    const files = s.phase === 'open' ? s.files : [];
    expect(files).toHaveLength(300);
    expect(files.filter((f) => f.status.s !== 'refused')).toHaveLength(200);
    run.send({ type: 'stop' });
    const over = run.outcome().notices.filter((n) => n.text === OVER_LIMIT_TEXT);
    expect(over).toHaveLength(100);
    // A ZIP not yet listed counts as one until it is: z6 leaves room for z7 to z9.
    expect(over[0]).toEqual({ name: 'z6.zip/z6.zip-17.pdf', reason: 'limitError', text: OVER_LIMIT_TEXT });
  });
});
