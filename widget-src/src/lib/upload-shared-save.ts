/**
 * The shared Save as the web's upload flow runs it (hooks/useUploadFlow.ts, the `save` effect):
 * one `saveUpload` (lib/roadmap-data.ts), answered with the flow's own event. After a commit landed, the page re-reads
 * the record: the commit wrote any screening date through `setScreening` and skipped the form's in-memory patch, so
 * without the re-read the form would show the old date (owner ruling, 2026-11-22; US-13 AC6, US-34 AC4). One commit
 * or none: no partial save waits for a re-read.
 */
import type { UploadEvent } from '@roadmap/health-core/upload-flow';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import { SAVE_FAILED, type UploadEngine, type WebSaving } from '../storage/upload-save-store';
import { recordFailure, writesStopped } from './error-diagnostics';
import { saveUpload } from './roadmap-data';
import { Sentry } from './sentry';
import { webUploadIO } from './upload-save-io';
import type { Held } from './upload-read';

/** A re-read that fails, at once or later, is only reported, as today's Save reports it: what saved stays saved. */
const reportReread = (err: unknown) => {
  if (!writesStopped(err)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'reread' } });
};

/** `engine`: the upload bundle the flow already loaded for the read. `complete`: the page's re-read (HealthTool's
 *  `rereadRecord`), run after a landed commit and not awaited. */
export async function sharedSave(engine: UploadEngine, s: WebSaving, held: Held, person: ScreeningPerson | undefined, complete: () => void | Promise<void>): Promise<Extract<UploadEvent, { type: 'saved' | 'saveFailed' }>> {
  const { run, attempt } = s;
  let answer: Awaited<ReturnType<typeof saveUpload>>;
  try {
    answer = await saveUpload(engine, s, new Date().toISOString(), webUploadIO(held), person);
  } catch (err) {
    if (!writesStopped(err)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'commit' } });
    return { type: 'saveFailed', run, attempt, message: SAVE_FAILED };
  }
  // A refusal says the page's own words for a failed Save: the engine's are for developers (owner ruling 5, 2026-11-22).
  if (!answer.ok) return { type: 'saveFailed', run, attempt, message: SAVE_FAILED };
  try { void Promise.resolve(complete()).catch(reportReread); } catch (err) { reportReread(err); }
  return { type: 'saved', run, attempt, outcome: answer.outcome };
}
