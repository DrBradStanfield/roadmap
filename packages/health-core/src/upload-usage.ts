/**
 * The usage counts an upload run adds to `upload_outcome` (US-12 AC10, design
 * §7 R9), derived from the shared upload state. Counts only: never a file's
 * name, hash or anything it read. Each is capped at UPLOAD_OUTCOME_MAX.
 */
import type { UploadState } from './upload-flow';
import { UPLOAD_OUTCOME_MAX, type UploadOutcomeKey } from './upload-events';

export type UploadUsageCounts = Partial<Record<Extract<UploadOutcomeKey, 'known' | 'failedFinal' | 'firstReadSeconds'>, number>>;

const cap = (n: number) => Math.min(Math.max(n, 0), UPLOAD_OUTCOME_MAX);

/**
 * `known`: files skipped as already held. `failedFinal`: files failed now, at
 * Save or Close. `firstReadSeconds`: whole seconds from the pick to the first
 * read file, left out until one is read or when a time cannot be read.
 */
export function uploadUsageCounts(s: UploadState): UploadUsageCounts {
  if (s.phase === 'choosing') return {};
  const count = (stage: 'known' | 'failed') => cap(s.files.filter((f) => f.status.s === stage).length);
  const ms = s.firstRead === null ? NaN : Date.parse(s.firstRead) - Date.parse(s.started);
  return { known: count('known'), failedFinal: count('failed'), ...(Number.isFinite(ms) ? { firstReadSeconds: cap(Math.floor(ms / 1000)) } : {}) };
}
