/**
 * Mount step 3a (US-12 AC6, US-34 AC4): the shared Save as the flow runs it answers with the flow's own event, and the
 * page re-reads the record only after a commit landed, never after a refusal. A throw or a failed re-read is reported
 * with tags only; what saved stays saved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { saveUpload } from './roadmap-data';
import { Sentry } from './sentry';
import { emptyHeld } from './upload-read';
import { sharedSave } from './upload-shared-save';

vi.mock('./roadmap-data', () => ({ saveUpload: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const saving: Extract<UploadState, { phase: 'saving' }> = { phase: 'saving', platform: 'web', run: 3, files: [], started: '', firstRead: null, attempt: 2 };
const OUTCOME = { values: 2, documents: 1, archived: 0, unstored: 0 };
type Answer = Awaited<ReturnType<typeof saveUpload>>;

beforeEach(() => { vi.mocked(Sentry.captureException).mockClear(); });

describe('mount 3a: the shared Save\'s flow event and re-read', () => {
  it.each([
    ['a landed commit: saved, then the re-read', { ok: true, outcome: OUTCOME, added: [] } as Answer, { type: 'saved', run: 3, attempt: 2, outcome: OUTCOME }, 1],
    ['an erase refusal: the page\'s words, no re-read', { ok: false, reason: 'erased', message: 'Failed to save. Please try again.' } as Answer, { type: 'saveFailed', run: 3, attempt: 2, message: 'Failed to save. Please try again.' }, 0],
    ['a not-ready refusal: the engine\'s own words, no re-read', { ok: false, reason: 'not-ready', message: 'Synthetic engine words.' } as Answer, { type: 'saveFailed', run: 3, attempt: 2, message: 'Synthetic engine words.' }, 0],
  ])('%s', async (_case, answer, event, rereads) => {
    vi.mocked(saveUpload).mockResolvedValue(answer);
    const complete = vi.fn();
    expect(await sharedSave(saving, emptyHeld(3), undefined, complete)).toEqual(event);
    expect(complete).toHaveBeenCalledTimes(rereads);
  });

  it('a throw is a failed Save in the page\'s words, reported with tags only', async () => {
    vi.mocked(saveUpload).mockRejectedValue(new Error('Synthetic test: the store threw'));
    const complete = vi.fn();
    expect(await sharedSave(saving, emptyHeld(3), undefined, complete)).toEqual({ type: 'saveFailed', run: 3, attempt: 2, message: 'Failed to save. Please try again.' });
    expect(complete).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureException).mock.calls[0][1]).toEqual({ tags: { area: 'upload-save', branch: 'commit' } });
  });

  it('a re-read that fails is only reported: the Save stands', async () => {
    vi.mocked(saveUpload).mockResolvedValue({ ok: true, outcome: OUTCOME, added: [] });
    const event = await sharedSave(saving, emptyHeld(3), undefined, () => Promise.reject(new Error('Synthetic test: the re-read failed')));
    await Promise.resolve();
    expect(event).toMatchObject({ type: 'saved' });
    expect(vi.mocked(Sentry.captureException).mock.calls[0][1]).toEqual({ tags: { area: 'upload-save', branch: 'reread' } });
  });

  it('the person reaches the Save as the caller hands it', async () => {
    vi.mocked(saveUpload).mockResolvedValue({ ok: true, outcome: OUTCOME, added: [] });
    await sharedSave(saving, emptyHeld(3), { age: 55, sex: 'female' }, () => {});
    expect(vi.mocked(saveUpload).mock.calls.at(-1)?.[3]).toEqual({ age: 55, sex: 'female' });
  });
});
