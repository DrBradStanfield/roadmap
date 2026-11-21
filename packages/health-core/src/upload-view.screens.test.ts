/**
 * US-12 AC9: on every screen, each file at rest that was not fully read shows its one reason exactly once, counted over
 * the channels that screen draws (FILE_REASON_DRAWN); a fully read file shows none. The one exception, FILE_REASON_TWICE:
 * the iPhone's review names a failed file twice. Fixtures are built from the unions (every status, fail reason and
 * refusal verdict), so a new member fails typecheck here or meets `fileReason`'s throw. Synthetic files, no values.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES } from './upload-choices';
import { initialUpload, transition, type FailReason, type FileStatus, type UploadEvent, type UploadFile, type UploadState } from './upload-flow';
import type { UploadPlatform } from './upload-rules';
import { uploadReview } from './upload-review';
import { FAIL_TEXT, UPLOAD_TEXT } from './upload-text';
import { FILE_REASON_DRAWN, FILE_REASON_TWICE, fileReason, uploadView, type UploadView } from './upload-view';

type Screen = 'review' | 'done';
const PROGRESS: readonly string[] = [UPLOAD_TEXT.statusRead, UPLOAD_TEXT.statusReading, UPLOAD_TEXT.statusWaiting];

/** The reason lines a screen shows for one file, over the channels it draws; a progress word is no reason. */
function shown(view: UploadView, platform: UploadPlatform, screen: Screen, fileId: string): string[] {
  const failed = view.sections.flatMap((x) => (x.kind === 'failed' ? x.rows : []));
  return FILE_REASON_DRAWN[platform][screen].flatMap((key) => (key === 'files' ? view.files.rows.map((r) => ({ fileId: r.fileId, line: r.status }))
    : key === 'notices' ? view.notices : failed)).filter((l) => l.fileId === fileId && !PROGRESS.includes(l.line)).map((l) => l.line);
}
const viewOf = (s: UploadState) => uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), true);

const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: '2026-10-20', values: [core()], additionalValues: [], unrecognized: [], document: null, ...over });
const letterDoc = { classification: 'clinic_letter', title: 'Letter', documentDate: '2026-10-20', contentMarkdown: 'text', metadata: {} };
const file = (id: string, status: FileStatus, truncated = false): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated }, status });
const read = (id: string, x: UnifiedExtractionResult, truncated = false) => file(id, { s: 'read', extraction: x, choices: NO_CHOICES }, truncated);
const VERDICTS: Record<Extract<FileStatus, { s: 'refused' }>['verdict'], true> = { tooLarge: true, unsupported: true, tooMany: true };
const FAIL_REASONS = Object.keys(FAIL_TEXT) as FailReason[];

/** Every status, each with its variants: a status added to FileStatus fails typecheck here. */
const FIXTURES: { [K in FileStatus['s']]: UploadFile[] } = {
  unlisted: [file('unlisted', { s: 'unlisted' })], listing: [file('listing', { s: 'listing' })],
  waiting: [file('waiting', { s: 'waiting' })], hashing: [file('hashing', { s: 'hashing' })], hashed: [file('hashed', { s: 'hashed' })],
  converting: [file('converting', { s: 'converting' })], ready: [file('ready', { s: 'ready', attempt: 0 })], sending: [file('sending', { s: 'sending', attempt: 0 })],
  known: [false, true].map((archiveOnly) => ({ ...file(`known-${archiveOnly}`, { s: 'known', as: 'document', archiveOnly }), pages: null })),
  refused: (Object.keys(VERDICTS) as Array<keyof typeof VERDICTS>).map((verdict) => ({ ...file(`refused-${verdict}`, { s: 'refused', verdict }), hash: null, pages: null })),
  failed: [...FAIL_REASONS.map((reason) => file(`failed-${reason}`, { s: 'failed', reason, attempt: 0 })), file('failed-cut', { s: 'failed', reason: 'server', attempt: 0 }, true)],
  stopped: [file('stopped', { s: 'stopped' }), file('stopped-cut', { s: 'stopped' }, true)],
  read: [
    read('full', labX()), read('empty', labX({ values: [] })), read('documentOnly', labX({ values: [], document: letterDoc })),
    read('cut', labX(), true), read('cut-empty', labX({ values: [] }), true), read('letter', { ...labX({ values: [] }), classification: 'clinic_letter', document: letterDoc }),
  ],
};
const ALL = Object.values(FIXTURES).flat();

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
  for (const platform of ['web', 'phone'] as const) {
    for (const phase of PHASES) {
      it(`${platform}, ${phase}`, () => {
        const s = stateIn(phase, platform, ALL);
        const screen: Screen = phase === 'done' ? 'done' : 'review';
        const view = viewOf(s);
        for (const f of ALL) {
          const reason = fileReason(f, s);
          const twice = platform === FILE_REASON_TWICE.platform && screen === FILE_REASON_TWICE.screen && f.status.s === FILE_REASON_TWICE.status;
          const lines = shown(view, platform, screen, f.id);
          // A read file's two soft reasons may sit as two notices beside its row: together they are its one reason.
          expect(twice ? lines : lines.join(' ') || null, f.id).toEqual(twice ? [reason, reason] : reason);
          expect(view.files.rows.find((r) => r.fileId === f.id)?.notFullyRead, f.id).toBe(reason !== null);
        }
      });
    }
  }

  it('the soft reasons: cut short, then nothing in it; never "first part" for a file not read', () => {
    const s = stateIn('done', 'web', ALL);
    const at = (id: string) => fileReason(ALL.find((f) => f.id === id)!, s);
    expect([at('full'), at('letter')]).toEqual([null, null]);
    expect(at('cut-empty')).toBe('This file is long, so only its first part was read. No blood test values found.');
    expect(at('documentOnly')).toBe('Filed as a document. No blood test values found.');
    expect([at('failed-cut'), at('stopped-cut')]).toEqual(["Our server could not read it. Please try again.", 'Not read: you stopped the upload.']);
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
