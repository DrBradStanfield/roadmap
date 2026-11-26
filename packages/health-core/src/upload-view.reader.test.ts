/**
 * US-12 AC9: a failed read names the reader that failed. The GitHub Pages build has no server of
 * ours: the person's own Anthropic key reads each file, so its failed file says Anthropic, never
 * "our server". The web says which reader it uses once, at upload start (`initialUpload`); the
 * iPhone says nothing and keeps its own words. Synthetic files, no values.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY, NOW } from './import-review.test-helpers';
import { initialUpload, transition, type FailReason, type UploadFile, type UploadState } from './upload-flow';
import type { UploadReader, UploadPlatform } from './upload-rules';
import { uploadReview } from './upload-review';
import { UPLOAD_STATE } from './upload-schema';
import { uploadView } from './upload-view';

const failedFile = (id: string, reason: FailReason): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'failed', reason, attempt: 0 } });

/** What the person sees for each failed file: the failed section's line and the Files row's status. */
function seen(platform: UploadPlatform, reader: UploadReader | undefined) {
  const s: UploadState = { phase: 'open', platform, run: 1, files: [failedFile('s', 'server'), failedFile('n', 'network')], started: NOW, firstRead: null, ...(reader ? { reader } : {}) };
  const view = uploadView(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), true);
  const failed = view.sections.flatMap((x) => (x.kind === 'failed' ? x.rows.map((r) => r.line) : []));
  return { failed, files: view.files.rows.map((r) => r.status) };
}

const OUR_SERVER = 'Our server could not read it. Please try again.';
const ANTHROPIC = 'Not read. Anthropic could not be reached or could not read it. Please try again.';

describe('US-12 AC9: a failed read names its reader', () => {
  it('the Shopify build, read by our server: "Our server could not read it."', () => {
    expect(seen('web', 'server')).toEqual({ failed: [OUR_SERVER, OUR_SERVER], files: [OUR_SERVER, OUR_SERVER] });
    // A web state that names no reader is read by the server, as every state before the field was.
    expect(seen('web', undefined)).toEqual(seen('web', 'server'));
  });

  it('the Pages build, read by the person\'s own key: Anthropic\'s words, never "our server"', () => {
    expect(seen('web', 'ownKey')).toEqual({ failed: [ANTHROPIC, ANTHROPIC], files: [ANTHROPIC, ANTHROPIC] });
  });

  it('the iPhone keeps its own words', () => {
    const phone = ['The server could not answer just now. Please try again later.', 'The connection dropped before the answer finished. Please try again.'];
    expect(seen('phone', undefined)).toEqual({ failed: phone, files: phone });
  });

  it('the reader is set once at upload start and kept through a pick and a discard', () => {
    const start = initialUpload('web', 'ownKey');
    const picked = transition(start, { type: 'picked', files: [{ id: 'a', name: 'a.pdf', bytes: 1, kind: 'file' }], needsConsent: false, now: NOW }).state;
    expect(picked).toMatchObject({ phase: 'open', reader: 'ownKey' });
    expect(transition(picked, { type: 'discard' }).state).toEqual({ phase: 'choosing', platform: 'web', run: 1, reader: 'ownKey' });
    // The iPhone's start is unchanged: no reader key at all.
    expect(initialUpload('phone')).toEqual({ phase: 'choosing', platform: 'phone', run: 0 });
  });

  it('a stored state names only a known reader', () => {
    expect(UPLOAD_STATE.safeParse(initialUpload('web', 'ownKey')).success).toBe(true);
    expect(UPLOAD_STATE.safeParse({ ...initialUpload('web'), reader: 'someoneElse' }).success).toBe(false);
  });
});
