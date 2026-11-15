/**
 * The upload review's Save (US-12 AC6, US-52 AC8c, design 12c): health-core `uploadSave`, the pick's
 * values, documents, lab archive rows and screening dates in ONE edit on the record as it stands at
 * commit time (RoadmapStore.saveUpload). The web holds each original by file id and hands it over as
 * the save writes it; with no cloud, none is held. One attempt: what it wrote, or the words that keep
 * the review open for a retry. Nothing here logs a value, a name or a hash.
 */
import type { UploadState } from '@roadmap/health-core/upload-flow';
import type { SavedOutcome } from '@roadmap/health-core/upload-save';
import { uploadReview, type ScreeningProfile } from '@roadmap/health-core/upload-review';
import { SAVE_FAILED_TEXT } from '@roadmap/health-core/upload-text';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { saveUpload } from './roadmap-data';
import { Sentry } from './sentry';
import { recordFailure, WritesStoppedError } from './error-diagnostics';
import type { Held } from './upload-read';

/** `reviewed`: the record the person reviewed; Save plans on it and writes on the record as it is at commit time. */
export async function saveAttempt(state: UploadState, reviewed: RoadmapFile, held: Held, cloud: boolean, screening: ScreeningProfile): Promise<{ outcome: SavedOutcome } | { message: string }> {
  const now = new Date().toISOString();
  // The labs the review does not send for their unit, counted as refused spellings once Save lands (US-21 AC15).
  const labRefusals = uploadReview(state, reviewed, now, screening).classification.values
    .flatMap((v) => (v.group === 'notSaved' && v.refusal && 'lab' in v.refusal ? [v.refusal.lab] : []));
  const file = (id: string) => held.files.get(id)?.file;
  try {
    const answer = await saveUpload(state, reviewed, now, cloud, {
      holds: (id) => cloud && !!file(id), original: (id) => file(id) ?? null, mimeType: (id) => file(id)?.type ?? '', screening,
    }, labRefusals);
    return answer.ok ? { outcome: answer.outcome } : { message: answer.message ?? SAVE_FAILED_TEXT };
  } catch (err) {
    // A throw is a programming error, not a store result: reported by tag only; a log-off refusal is not (US-09 AC2c).
    if (!(err instanceof WritesStoppedError)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'save' } });
    return { message: SAVE_FAILED_TEXT };
  }
}
