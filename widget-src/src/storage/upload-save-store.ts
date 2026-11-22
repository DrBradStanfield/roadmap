/**
 * The web's one upload Save (US-52 AC8c, US-14 AC10, US-16 AC2a): health-core `uploadSave` on the open record, its
 * originals written to the person's cloud through the store's adapter, then its `commit` applied through ONE
 * `session.edit` stamped with the erase the page showed when the Save began. Values, documents, originals' rows and
 * screening dates land together or not at all; there is no second write path. As ios/engine/upload-save-door.ts does
 * for the phone. The web's upload flow calls it through lib/upload-shared-save.ts (mount 3b).
 */
import { busyWait } from '@roadmap/health-core/adapter';
import { writeMakesFolders } from '@roadmap/health-core/document-save';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { RecordSession } from '@roadmap/health-core/record-session';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import type { SavedOutcome, UploadSaveIO } from '@roadmap/health-core/upload-save';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import { recordFailure, WritesStoppedError } from '../lib/error-diagnostics';
import { Sentry } from '../lib/sentry';
// Type only: the engine comes from the upload bundle, so a page that never uploads never loads it.
import type { HealthUploadAPI } from '../upload-entry';

/** An original as the web holds it: its bytes are read only as it is written, so a ZIP member inflates then. */
export type Original = () => Promise<Blob>;
/** The shared engine's Save and review, from the upload bundle (upload-entry.ts). */
export type UploadEngine = Pick<HealthUploadAPI, 'uploadSave' | 'uploadReview'>;
/** What the page holds of the pick: the store adds the cloud write and the erase check. */
export type WebUploadIO = Omit<UploadSaveIO<Original>, 'write' | 'stopped'>;

/** The page's words for a Save that wrote nothing: an erase moved, or a throw. */
export const SAVE_FAILED = 'Failed to save. Please try again.';

/** `added`: the vitals this Save inserted as new, never a correction (`measurement_added`, US-07 AC11). `no-record`:
 *  no record is open, as today's writers answer with an error count. */
export type UploadSaveAnswer =
  | { ok: true; outcome: SavedOutcome; added: ApiMeasurement[] }
  | { ok: false; reason: 'not-saving' | 'not-ready' | 'erased' | 'no-record'; message: string };

const ERASED = { ok: false, reason: 'erased', message: SAVE_FAILED } as const;

/** A failed original write, reported as the store reports one: tags only, never a name, a value or the bytes. A
 *  log-off refusal is not reported (US-09 AC2c). */
export function reportUnstored(error: unknown, backend: string): void {
  if (error instanceof WritesStoppedError) return;
  console.warn('Document file not stored');
  Sentry.captureException(recordFailure(error, 'Document file not stored'), { tags: { area: 'cloud-sync', op: 'write-document', backend } });
}

/** The person's cloud, as the store holds it: the one writer of an original's bytes stays in the store (US-09 AC2c). */
export interface OriginalsCloud { write(ref: string, blob: Blob): Promise<void>; backend: string }

export async function saveUploadThrough(
  session: RecordSession, cloud: OriginalsCloud, engine: UploadEngine, s: UploadState, now: string, cloudConnected: boolean, io: WebUploadIO, person?: ScreeningPerson,
): Promise<UploadSaveAnswer> {
  // The Save stands for the erase the page showed as it began: refused before any write, before each original and at
  // the commit, since an erase can land while the originals upload (US-16 AC2a, US-11 AC1a).
  const erase = session.shownErase;
  if (session.refuses(erase)) return ERASED;
  /** An original a busy refusal will retry: its bytes kept, so a retry does not inflate them again. */
  const retrying = new Map<string, Blob>();
  /** Originals already reported busy: once each, at the first refusal. */
  const busy = new Set<string>();
  const out = await engine.uploadSave(s, session.file, now, cloudConnected, {
    ...io,
    makesFolders: writeMakesFolders(cloud.backend),
    // The engine asks it before every write attempt, retries included (US-11 AC1a).
    stopped: () => session.refuses(erase),
    // A failed read or write is reported, then rethrown: the engine counts it `unstored` and its row keeps the hash
    // alone. The bytes go as the page holds them, a File with its own type, as the store's document save writes them.
    write: async (ref, original) => {
      let bytes: Blob;
      try {
        bytes = retrying.get(ref) ?? await original();
        retrying.delete(ref);
      } catch (error) {
        // The page could not read its own bytes (a ZIP member that would not inflate): no cloud refused anything.
        Sentry.captureException(recordFailure(error, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'original' } });
        throw error;
      }
      // Checked again once the bytes are in hand: an erase during a member's inflate sends nothing.
      if (session.refuses(erase)) throw new Error('erase moved');
      try {
        await cloud.write(ref, bytes);
      } catch (error) {
        // A busy refusal may still land on the engine's retry: counted on its own, once per original; `onWriteError`
        // reports it if it never lands.
        if (session.refuses(erase)) throw error;
        if (busyWait(error) === null) reportUnstored(error, cloud.backend);
        else {
          retrying.set(ref, bytes);
          if (!busy.has(ref)) Sentry.captureException(recordFailure(error, 'Document write busy'), { tags: { area: 'cloud-sync', op: 'write-document-busy', backend: cloud.backend } });
          busy.add(ref);
        }
        throw error;
      }
    },
    // Once per original that never landed: only the busy ones, since every other failure was reported as it came.
    onWriteError: (error) => {
      if (busyWait(error) !== null && !session.refuses(erase)) reportUnstored(error, cloud.backend);
    },
  }, person);
  if (!out.ok) return out;
  const before = new Set(session.file.measurements.map((m) => m.id));
  let landed: ReturnType<typeof out.commit> | null = null;
  // The rows land on the record as it is now: an edit that landed while the originals uploaded is kept.
  if (!session.edit((file) => (landed = out.commit(file)).file, erase) || !landed) return ERASED;
  const { outcome } = landed as ReturnType<typeof out.commit>;
  const added = session.file.measurements.filter((m) => !before.has(m.id) && m.status === 'active' && !m.correctsId) as unknown as ApiMeasurement[];
  return { ok: true, outcome, added };
}
