/**
 * US-12 AC9: on every screen, each file refused, failed or stopped, and each read file cut short or with nothing in it,
 * shows its one reason exactly once, counted over the channels that screen draws; any other file shows none. The one
 * exception: the iPhone's review names a failed file twice. This test is its own oracle: what each screen draws and each
 * file's reason are written here, from the renderers and the word constants, never read from the rule under test.
 * Fixtures are built from the unions (every status, fail reason and refusal verdict), so a new member fails typecheck
 * here or meets `fileReason`'s throw. Synthetic files, no values.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES } from './upload-choices';
import { initialUpload, transition, type FailReason, type FileStatus, type UploadEvent, type UploadFile, type UploadState } from './upload-flow';
import type { UploadPlatform } from './upload-rules';
import { uploadReview } from './upload-review';
import { FAIL_TEXT, FILE_NOTICE_TEXT, KEY_TEXT, OVER_LIMIT_TEXT, PHONE_FAIL_TEXT, UPLOAD_TEXT } from './upload-text';
import { FILE_REASON_DRAWN, FILE_REASON_TWICE, fileReason, uploadView, type UploadView } from './upload-view';

type Screen = 'review' | 'done';
type Channel = 'files' | 'notices' | 'failed';
/** What each renderer draws of a file's reason, read from its code. */
const DRAWN: Record<UploadPlatform, Record<Screen, Channel[]>> = {
  web: {
    // widget-src UploadList.tsx:196 `<Files>`: UploadListParts.tsx:22-33 draws the Files rows; the failed section feeds only Try again.
    review: ['files'],
    // UploadList.tsx:137 `<Done>`: the Files rows marked `notFullyRead`.
    done: ['files'],
  },
  phone: {
    // ios UploadReviewView.swift:81 every section (the failed one at :145), :82-83 the notices, :89 the Files rows (collapsed).
    review: ['failed', 'notices', 'files'],
    // UploadReviewView.swift:47-58: the done lines, the Not saved sections, then the Files rows alone.
    done: ['files'],
  },
};
const PROGRESS: readonly string[] = [UPLOAD_TEXT.statusRead, UPLOAD_TEXT.statusReading, UPLOAD_TEXT.statusWaiting];

/** The reason lines a screen shows for one file, over the channels it draws; a status word is no reason. */
function shown(view: UploadView, platform: UploadPlatform, screen: Screen, fileId: string): string[] {
  const failed = view.sections.flatMap((x) => (x.kind === 'failed' ? x.rows : []));
  return DRAWN[platform][screen].flatMap((key) => (key === 'files' ? view.files.rows.map((r) => ({ fileId: r.fileId, line: r.status }))
    : key === 'notices' ? view.notices : failed))
    .filter((l) => l.fileId === fileId && !PROGRESS.includes(l.line) && l.line !== UPLOAD_TEXT.statusKnown).map((l) => l.line);
}
const viewOf = (s: UploadState) => uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), true);

const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: '2026-10-20', values: [core()], additionalValues: [], unrecognized: [], document: null, ...over });
const letterDoc = { classification: 'clinic_letter', title: 'Letter', documentDate: '2026-10-20', contentMarkdown: 'text', metadata: {} };
const file = (id: string, status: FileStatus, truncated = false): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated }, status });
const read = (id: string, x: UnifiedExtractionResult, truncated = false) => file(id, { s: 'read', extraction: x, choices: NO_CHOICES }, truncated);
type Verdict = Extract<FileStatus, { s: 'refused' }>['verdict'];
/** Each refusal's words, written out. */
const REFUSED: Record<Verdict, string> = { tooLarge: 'Too large to read', unsupported: 'Not a PDF, photo or ZIP', tooMany: OVER_LIMIT_TEXT };
const FAIL_REASONS = Object.keys(FAIL_TEXT) as FailReason[];
/** Where the iPhone's words for a failure differ from the web's, written out. */
const PHONE_FAIL: Partial<Record<FailReason, string>> = {
  declined: PHONE_FAIL_TEXT.declined, tooLong: PHONE_FAIL_TEXT.declined, server: PHONE_FAIL_TEXT.noAnswer, network: PHONE_FAIL_TEXT.network.dropped,
};
const failWords = (reason: FailReason, platform: UploadPlatform) => (platform === 'phone' ? PHONE_FAIL[reason] : undefined) ?? FAIL_TEXT[reason];

/** Every status, each with its variants, and its expected reason: a status added to FileStatus fails typecheck here. */
type Fixture = { f: UploadFile; reason: (platform: UploadPlatform) => string | null };
const none = () => null;
const FIXTURES: { [K in FileStatus['s']]: Fixture[] } = {
  unlisted: [{ f: file('unlisted', { s: 'unlisted' }), reason: none }], listing: [{ f: file('listing', { s: 'listing' }), reason: none }],
  waiting: [{ f: file('waiting', { s: 'waiting' }), reason: none }], hashing: [{ f: file('hashing', { s: 'hashing' }), reason: none }],
  hashed: [{ f: file('hashed', { s: 'hashed' }), reason: none }], converting: [{ f: file('converting', { s: 'converting' }), reason: none }],
  ready: [{ f: file('ready', { s: 'ready', attempt: 0 }), reason: none }], sending: [{ f: file('sending', { s: 'sending', attempt: 0 }), reason: none }],
  known: [false, true].map((archiveOnly) => ({ f: { ...file(`known-${archiveOnly}`, { s: 'known', as: 'document', archiveOnly }), pages: null }, reason: none })),
  refused: (Object.keys(REFUSED) as Verdict[]).map((verdict) => ({ f: { ...file(`refused-${verdict}`, { s: 'refused', verdict }), hash: null, pages: null }, reason: () => REFUSED[verdict] })),
  failed: [
    ...FAIL_REASONS.map((reason) => ({ f: file(`failed-${reason}`, { s: 'failed', reason, attempt: 0 }), reason: (p: UploadPlatform) => failWords(reason, p) })),
    { f: file('failed-cut', { s: 'failed', reason: 'server', attempt: 0 }, true), reason: (p: UploadPlatform) => failWords('server', p) },
  ],
  stopped: [
    { f: file('stopped', { s: 'stopped' }), reason: () => UPLOAD_TEXT.stoppedLine },
    { f: file('stopped-cut', { s: 'stopped' }, true), reason: () => UPLOAD_TEXT.stoppedLine },
  ],
  read: [
    { f: read('full', labX()), reason: none },
    { f: read('empty', labX({ values: [] })), reason: () => FILE_NOTICE_TEXT.noValues },
    { f: read('documentOnly', labX({ values: [], document: letterDoc })), reason: () => FILE_NOTICE_TEXT.documentOnly },
    { f: read('cut', labX(), true), reason: () => FILE_NOTICE_TEXT.truncated },
    { f: read('cut-empty', labX({ values: [] }), true), reason: () => `${FILE_NOTICE_TEXT.truncated} ${FILE_NOTICE_TEXT.noValues}` },
    { f: read('letter', { ...labX({ values: [] }), classification: 'clinic_letter', document: letterDoc }), reason: none },
  ],
};
const ALL = Object.values(FIXTURES).flat();
const FILES = ALL.map((x) => x.f);

const PHASES = ['open', 'saving', 'saveFailed', 'done', 'failed'] as const;
function stateIn(phase: (typeof PHASES)[number], platform: UploadPlatform, files: UploadFile[]): UploadState {
  const pick = { platform, run: 1, files, started: NOW, firstRead: null };
  switch (phase) {
    case 'open': return { ...pick, phase };
    case 'saving': return { ...pick, phase, attempt: 1 };
    case 'saveFailed': return { ...pick, phase, attempt: 1, message: 'Could not save.' };
    case 'done': return { ...pick, phase, outcome: { values: 0, documents: 0, archived: 0 } };
    case 'failed': return { ...pick, phase, refused: null };
  }
}

describe('US-12 AC9: each file\'s reason, once on each screen', () => {
  it('the engine\'s table of what each screen draws is the renderers\' own', () => {
    expect(FILE_REASON_DRAWN).toEqual(DRAWN);
    expect(FILE_REASON_TWICE).toEqual({ platform: 'phone', screen: 'review', status: 'failed' });
  });

  for (const platform of ['web', 'phone'] as const) {
    for (const phase of PHASES) {
      it(`${platform}, ${phase}`, () => {
        const s = stateIn(phase, platform, FILES);
        const screen: Screen = phase === 'done' ? 'done' : 'review';
        const view = viewOf(s);
        for (const { f, reason } of ALL) {
          const want = reason(platform);
          expect(fileReason(f, s), f.id).toBe(want);
          const lines = shown(view, platform, screen, f.id);
          const twice = platform === 'phone' && screen === 'review' && f.status.s === 'failed';
          // A read file's two soft reasons may sit as two notices beside its row: together they are its one reason.
          expect(twice ? lines : lines.join(' ') || null, f.id).toEqual(twice ? [want, want] : want);
          expect(view.files.rows.find((r) => r.fileId === f.id)?.notFullyRead, f.id).toBe(want !== null);
        }
      });
    }
  }

  it('a file already in the record keeps its status on every screen, and is no reason', () => {
    for (const platform of ['web', 'phone'] as const) {
      for (const phase of PHASES) {
        const rows = viewOf(stateIn(phase, platform, FIXTURES.known.map((x) => x.f))).files.rows;
        expect(rows.map((r) => [r.status, r.notFullyRead]), `${platform} ${phase}`).toEqual([[UPLOAD_TEXT.statusKnown, false], [UPLOAD_TEXT.statusKnown, false]]);
      }
    }
  });

  it('a status the rule does not know throws', () => {
    expect(() => fileReason(file('x', { s: 'mystery' } as unknown as FileStatus), stateIn('open', 'web', []))).toThrow(/no rule/);
  });
});

describe('US-12 AC9: a mixed pick, one readable file and one over the size cap, through to done', () => {
  const run = (platform: UploadPlatform) => {
    const step = (s: UploadState, e: UploadEvent) => transition(s, e).state;
    let s = step(initialUpload(platform), { type: 'picked', needsConsent: false, now: NOW, files: [
      { id: 'a', name: 'labs.pdf', bytes: 1000, kind: 'file' }, { id: 'b', name: 'big.pdf', bytes: 11 * 1024 * 1024, kind: 'file' }] });
    s = step(s, { type: 'hashed', run: 1, id: 'a', hash: 'h-a', known: null });
    s = step(s, { type: 'converted', run: 1, id: 'a', pages: 1, truncated: false });
    s = step(s, { type: 'answered', run: 1, id: 'a', extraction: labX(), legacy: false, now: NOW });
    const saving = step(s, { type: 'saveStarted' });
    return { review: s, done: step(saving, { type: 'saved', run: 1, attempt: 1, outcome: { values: 1, documents: 0, archived: 0 } }) };
  };
  for (const platform of ['web', 'phone'] as const) {
    it(`names the large file once with "Too large to read" on the ${platform} review and done screens, the read one not at all`, () => {
      const states = run(platform);
      expect(states.done.phase).toBe('done');
      for (const screen of ['review', 'done'] as const) {
        expect(shown(viewOf(states[screen]), platform, screen, 'b')).toEqual(['Too large to read']);
        expect(shown(viewOf(states[screen]), platform, screen, 'a')).toEqual([]);
      }
    });
  }
});

// A run refused before any read (`runRefused`, US-12 AC10): its own line (`view.refused`) is a channel too, drawn on both
// clients (widget-src UploadList.tsx `view.refused`; the iPhone's failed phase). Each file's reason, counted over the
// screen's channels and that line, shows once: where the run's line already says a file's words, the file says nothing
// of its own (US-12 AC10: the no-key run names no file). The other refusals word each file apart from the run's line.
describe('US-12 AC9, AC10: a refused run says each reason once, counting its own line', () => {
  const refusedRun = (platform: UploadPlatform, reason: 'dailyLimit' | 'noKey' | 'server') => {
    const step = (s: UploadState, e: UploadEvent) => transition(s, e).state;
    const s = step(initialUpload(platform), { type: 'picked', needsConsent: false, now: NOW, files: [
      { id: 'a', name: 'a.pdf', bytes: 1000, kind: 'file' }, { id: 'b', name: 'b.pdf', bytes: 1000, kind: 'file' }] });
    return step(s, { type: 'runRefused', run: 1, reason });
  };
  /** Every line the refused screen draws in a file's words, its run's line included where that line is those words. */
  const drawn = (view: UploadView, platform: UploadPlatform, fileId: string, words: string) =>
    [...shown(view, platform, 'review', fileId), ...(view.refused === words ? [view.refused] : [])].filter((l) => l === words);

  it('web, no key: the run\'s line alone says it; no file repeats it or is marked not fully read', () => {
    const view = viewOf(refusedRun('web', 'noKey'));
    expect(view.refused).toBe(KEY_TEXT.missing);
    for (const id of ['a', 'b']) {
      expect(drawn(view, 'web', id, KEY_TEXT.missing), id).toEqual([KEY_TEXT.missing]);
      expect(view.files.rows.find((r) => r.fileId === id)?.notFullyRead, id).toBe(false);
    }
  });

  // The iPhone is never refused for a missing key (its reader is the server); its run-level refusals word each file apart
  // from the run's line, so what it draws is unchanged: each file's line on its review's two channels (FILE_REASON_TWICE).
  for (const reason of ['dailyLimit', 'server'] as const) {
    it(`phone, ${reason}: each file keeps its own line, apart from the run's, twice on the review`, () => {
      const view = viewOf(refusedRun('phone', reason));
      const words = failWords(reason, 'phone');
      expect(view.refused).not.toBe(words);
      for (const id of ['a', 'b']) expect(drawn(view, 'phone', id, words), id).toEqual([words, words]);
    });
  }
});
