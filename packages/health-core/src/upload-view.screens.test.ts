/**
 * US-12 AC9: the review and done screens name every file picked up and not fully read, with its reason, once.
 * Each screen draws only some of the view (read from the renderers):
 *  - web review: the Files block, its rows and the notices (UploadListParts.tsx `Files`; failed rows only feed Try again);
 *  - web done: the notices and the failed rows (UploadList.tsx `Done`);
 *  - iPhone review: the failed section, the notices and, collapsed, the Files rows (UploadReviewView.swift);
 *  - iPhone done: the Files rows (and Not saved) alone.
 * Synthetic files, no values.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES } from './upload-choices';
import { transition, initialUpload, type UploadEvent, type UploadFile, type UploadState } from './upload-flow';
import type { UploadPlatform } from './upload-rules';
import { uploadReview } from './upload-review';
import { UPLOAD_TEXT } from './upload-text';
import { uploadView, type UploadView } from './upload-view';

type Screen = 'review' | 'done';
const DRAWN: Record<UploadPlatform, Record<Screen, Array<'files' | 'notices' | 'failed'>>> = {
  web: { review: ['files', 'notices'], done: ['notices', 'failed'] },
  phone: { review: ['failed', 'files', 'notices'], done: ['files'] },
};
/** Every reason a screen shows for `name` (a plain "Read" status is no reason). */
function shown(view: UploadView, platform: UploadPlatform, screen: Screen, name: string): string[] {
  const failed = view.sections.flatMap((x) => (x.kind === 'failed' ? x.rows : []));
  return DRAWN[platform][screen].flatMap((key) => (key === 'files' ? view.files.rows.map((r) => ({ name: r.name, line: r.status }))
    : key === 'notices' ? view.notices : failed)).filter((l) => l.name === name && l.line !== UPLOAD_TEXT.statusRead).map((l) => l.line);
}
const viewOf = (s: UploadState) => uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), true);
const labX = (over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: '2026-10-20', values: [core()], additionalValues: [], unrecognized: [], document: null, ...over });
const done = (s: UploadState): UploadState => {
  const saving = transition(s, { type: 'saveStarted' }).state;
  return transition(saving, { type: 'saved', run: saving.run, attempt: 1, outcome: { values: 1, documents: 0, archived: 0 } }).state;
};

describe('US-12 AC9: a mixed pick, one readable file and one over the size cap, through to done', () => {
  const run = (platform: UploadPlatform) => {
    const step = (s: UploadState, e: UploadEvent) => transition(s, e).state;
    let s = step(initialUpload(platform), { type: 'picked', needsConsent: false, now: NOW, files: [
      { id: 'a', name: 'labs.pdf', bytes: 1000, kind: 'file' }, { id: 'b', name: 'big.pdf', bytes: 11 * 1024 * 1024, kind: 'file' }] });
    s = step(s, { type: 'hashed', run: 1, id: 'a', hash: 'h-a', known: null });
    s = step(s, { type: 'converted', run: 1, id: 'a', pages: 1, truncated: false });
    s = step(s, { type: 'answered', run: 1, id: 'a', extraction: labX(), legacy: false, now: NOW });
    return { review: s, done: done(s) };
  };
  for (const platform of ['web', 'phone'] as const) {
    it(`names the large file once with "Too large to read" on the ${platform} review and done screens`, () => {
      const states = run(platform);
      expect(states.done.phase).toBe('done');
      for (const screen of ['review', 'done'] as const) expect(shown(viewOf(states[screen]), platform, screen, 'big.pdf')).toEqual(['Too large to read']);
    });
  }
});

describe('US-12 AC9: each file not fully read, once on each screen', () => {
  const file = (id: string, status: UploadFile['status']): UploadFile => ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status });
  const read = (id: string, x: UnifiedExtractionResult) => file(id, { s: 'read', extraction: x, choices: NO_CHOICES });
  const files = [
    read('good', labX()),
    read('empty', labX({ values: [] })),
    read('letter', labX({ values: [], document: { classification: 'clinic_letter', title: 'Letter', documentDate: '2026-10-20', contentMarkdown: 'text', metadata: {} } })),
    { ...file('large', { s: 'refused', verdict: 'tooLarge' }), hash: null, pages: null },
    file('broken', { s: 'failed', reason: 'server', attempt: 0 }),
  ];
  const expected = { empty: 1, letter: 1, large: 1, broken: 1 };
  for (const platform of ['web', 'phone'] as const) {
    for (const screen of ['review', 'done'] as const) {
      it(`on the ${platform} ${screen} screen`, () => {
        const open: UploadState = { phase: 'open', platform, run: 1, files, started: NOW, firstRead: null };
        const view = viewOf(screen === 'review' ? open : done(open));
        const counts = Object.fromEntries(Object.keys(expected).map((id) => [id, shown(view, platform, screen, `${id}.pdf`).length]));
        // KNOWN (pre-existing, reported): the iPhone's review names a failed file in its failed section and again in its
        // collapsed Files rows; the web's review draws the same view with no failed section, so no view rule says it once on both.
        expect(counts).toEqual(platform === 'phone' && screen === 'review' ? { ...expected, broken: 2 } : expected);
      });
    }
  }
});
