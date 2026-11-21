/**
 * The shared Save as the web's upload flow runs it once the list mounts (PR 3b; until then lib/upload-save.ts saves):
 * one `saveUpload` (lib/roadmap-data.ts), answered with the flow's own event. After a commit landed, the page re-reads
 * the record: the commit wrote any screening date through `setScreening` and skipped the form's in-memory patch, so
 * without the re-read the form would show the old date (owner ruling, 2026-11-22; US-13 AC6, US-34 AC4). One commit
 * or none: no partial save waits for a re-read.
 */
import type { UploadEvent, UploadState } from '@roadmap/health-core/upload-flow';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import { SAVE_FAILED } from '../storage/upload-save-store';
import { recordFailure, WritesStoppedError } from './error-diagnostics';
import { saveUpload } from './roadmap-data';
import { Sentry } from './sentry';
import { webUploadIO } from './upload-save-io';
import type { Held } from './upload-read';

type Saving = Extract<UploadState, { phase: 'saving' }>;

/** A re-read that fails, at once or later, is only reported, as today's Save reports it: what saved stays saved. */
const reportReread = (err: unknown) => {
  if (!(err instanceof WritesStoppedError)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'reread' } });
};

/** `complete`: the page's re-read (HealthTool's `rereadRecord`), run after a landed commit and not awaited. */
export async function sharedSave(s: Saving, held: Held, person: ScreeningPerson | undefined, complete: () => void | Promise<void>): Promise<Extract<UploadEvent, { type: 'saved' | 'saveFailed' }>> {
  const { run, attempt } = s;
  let answer: Awaited<ReturnType<typeof saveUpload>>;
  try {
    answer = await saveUpload(s, new Date().toISOString(), webUploadIO(held), person);
  } catch (err) {
    if (!(err instanceof WritesStoppedError)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'commit' } });
    return { type: 'saveFailed', run, attempt, message: SAVE_FAILED };
  }
  if (!answer.ok) return { type: 'saveFailed', run, attempt, message: answer.message };
  try { void Promise.resolve(complete()).catch(reportReread); } catch (err) { reportReread(err); }
  return { type: 'saved', run, attempt, outcome: answer.outcome };
}
