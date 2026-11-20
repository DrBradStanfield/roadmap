/**
 * The upload review's Save (US-12 AC6, US-52 AC8c, design 12c): health-core `uploadSave`, planned on
 * the record as it is when Save runs, the pick's values, documents, lab archive rows and screening
 * dates in ONE edit on the record as it stands at commit time (RoadmapStore.saveUpload). The web holds each original by file id and hands it over as
 * the save writes it; with no cloud, none is held. One attempt: what it wrote, or the words that keep
 * the review open for a retry. Nothing here logs a value, a name or a hash.
 */
import type { UploadState } from '@roadmap/health-core/upload-flow';
import type { SavedOutcome } from '@roadmap/health-core/upload-save';
import type { ScreeningProfile } from '@roadmap/health-core/upload-review';
import { SAVE_FAILED_TEXT } from '@roadmap/health-core/upload-text';
import { saveUpload } from './roadmap-data';
import { WRITE_REFUSED } from './erase-copy';
import { Sentry } from './sentry';
import { recordFailure, WritesStoppedError } from './error-diagnostics';
import type { Held } from './upload-read';

export async function saveAttempt(state: UploadState, held: Held, cloud: boolean, screening: ScreeningProfile): Promise<{ outcome: SavedOutcome } | { message: string }> {
  const now = new Date().toISOString();
  const file = (id: string) => held.files.get(id)?.file;
  try {
    const answer = await saveUpload(state, now, cloud, {
      holds: (id) => cloud && !!file(id), original: (id) => file(id) ?? null, mimeType: (id) => file(id)?.type ?? '', screening,
    });
    // An erase refusal says so in the page's words for a refused write (erase-copy WRITE_REFUSED).
    return answer.ok ? { outcome: answer.outcome } : { message: answer.message ?? WRITE_REFUSED };
  } catch (err) {
    // A throw is a programming error, not a store result: reported by tag only; a log-off refusal is not (US-09 AC2c).
    if (!(err instanceof WritesStoppedError)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'save' } });
    return { message: SAVE_FAILED_TEXT };
  }
}
