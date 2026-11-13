// The iPhone's document save (US-52 AC13d, US-14 AC5): one reviewed file filed as the web
// files it, through health-core's saveDocuments. Split from cloud.ts (file budget); it commits
// through the open cloud session as cloudEdit does.
import { StorageError } from '../../packages/health-core/src/adapter';
import { labArchivePayload, saveDocuments, type DocumentPayload, type DocumentSaveIO, type DocumentSavePlan } from '../../packages/health-core/src/document-save';
import { validDay } from '../../packages/health-core/src/record-edits';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { commit, ERASED, NOT_OPEN, open } from './cloud';
import { refuse } from './guarded-edit';
import { checkArgs } from './contract';
import type { Extraction } from './lab-review';
import { readRecord } from './my-data';

/** What the review chose for one file (US-52 AC13d). `mimeType` and
 *  `contentHash` ('sha256-<hex>', the web's sha256Blob format) are the original's
 *  as the review read it; both absent when there is none (a photo, a scan). */
type DocumentChoice = { sourceFileName: string; mimeType: string; contentHash?: string } & (
  | { kind: 'document'; title: string; documentDate: string | null }
  | { kind: 'labArchive'; reportDay: string | null });

/** Document saves run one after another, so each plans its refs against the
 *  record as the previous one committed it: two at once would be given the
 *  same ref and one original would overwrite the other. */
let documentQueue: Promise<unknown> = Promise.resolve();

/**
 * File one reviewed file as the web does (US-52 AC13d, US-14 AC5): health-core's
 * `saveDocuments`, the web's one save path. `document`: the letter or other
 * document, with the title and date the review shows. `labArchive`: a lab
 * report's original, as the hidden row the web keeps (`labArchivePayload`).
 *
 * With a cloud open (`erase` is the erase the screen showed) the original goes
 * to the person's cloud first, then the rows are committed the way cloudEdit
 * commits an edit: the phone's copy and its pending marker first, then
 * `RecordSession.edit` with the erase, refused if an erase arrived meanwhile.
 * `original` null with a `contentHash`: the file changed or could not be read
 * since the review read it, so the row is filed without it, with the reviewed
 * bytes' hash (US-14 AC4's metadata-only fallback), and the answer says `stale`.
 * With no cloud (`erase` ''), as on the web off-cloud, no original is kept: a
 * document is a text-only row added to `recordJson`, answered for Swift to
 * write to the phone's file, and a lab report's original is not kept at all.
 *
 * Answers `{ ok, record, erase?, saved, unstored, stored, stale }` or `{ ok: false, reason, message }`.
 * `stored`: the original reached the cloud; null when none was offered to one.
 */
export function documentSave(
  recordJson: string, extractionJson: string, choiceJson: string, original: ArrayBuffer | null, erase: string, nowIso: string, deviceId: string,
): Promise<string> {
  checkArgs('documentSave', arguments);
  const run = documentQueue.then(() => saveOneDocument(recordJson, extractionJson, choiceJson, original, erase, nowIso, deviceId)).then((answer) => JSON.stringify(answer));
  documentQueue = run.catch(() => {});
  return run;
}

async function saveOneDocument(
  recordJson: string, extractionJson: string, choiceJson: string, original: ArrayBuffer | null, erase: string, nowIso: string, deviceId: string,
): Promise<object> {
  const choice = JSON.parse(choiceJson) as DocumentChoice;
  const extraction = JSON.parse(extractionJson) as Extraction;
  const at = erase ? open : null;
  if (erase && !at) return refuse('not-open', NOT_OPEN);
  if (at?.session.refuses(erase)) return refuse('erased', ERASED);
  // The one gate for originals: kept only in the person's cloud, as on the web
  // (UploadModal strips them off-cloud).
  const hash = at ? choice.contentHash : undefined;
  const bytes = hash && original && original.byteLength > 0 ? new Uint8Array(original) : null;
  const file = hash ? bytes ?? new Uint8Array(0) : undefined;
  let plan: DocumentSavePlan | null = null;
  const answer = (record: string) => ({
    ok: true, record, ...(at ? { erase: at.session.eraseIdentity } : null),
    saved: plan?.saved.length ?? 0, unstored: plan?.unstored ?? 0,
    stored: hash ? !!plan?.saved.some((d) => !!d.fileRef) : null,
    stale: !!hash && !bytes,
  });
  let payload: DocumentPayload<Uint8Array<ArrayBuffer>>;
  if (choice.kind === 'labArchive') {
    if (!file) return answer(at ? JSON.stringify(at.session.file) : recordJson);
    payload = labArchivePayload(choice.sourceFileName, validDay(choice.reportDay, { now: nowIso }), file);
  } else {
    const doc = extraction.classification === 'lab_report' ? null : extraction.document;
    if (!doc) return refuse('not-found', 'This file has no document to save.');
    payload = {
      documentType: doc.classification, title: choice.title || doc.title, documentDate: validDay(choice.documentDate, { now: nowIso }),
      contentMd: doc.contentMarkdown, metadata: doc.metadata, sourceFileName: choice.sourceFileName, file,
    };
  }
  const io: DocumentSaveIO<Uint8Array<ArrayBuffer>> = {
    // Hashed by the phone as it read the file: the same bytes it uploads, or none.
    hash: async () => hash!,
    write: (ref, data) => (bytes
      ? at!.host.store.writeDocument(ref, new Blob([data], { type: choice.mimeType }))
      : Promise.reject(new StorageError('The original changed or could not be read.'))),
    mimeType: () => choice.mimeType,
  };

  if (!at) {
    const current = readRecord(recordJson, nowIso, deviceId);
    plan = await saveDocuments(current, [payload], io);
    return answer(JSON.stringify(committed(current, plan)));
  }

  plan = await saveDocuments(at.session.file, [payload], io);
  // The uploads took time: the session may have closed, or an erase arrived.
  if (open !== at) return refuse('not-open', 'The cloud record closed while this was saving, so it was not saved. Try again.');
  if (at.session.refuses(erase)) return refuse('erased', ERASED);
  if (plan.saved.length > 0) {
    const refusal = commit(at, committed(at.session.file, plan), erase, nowIso);
    if (refusal) return refusal;
  }
  return answer(JSON.stringify(at.session.file));
}

/** `file` with the plan's rows committed. The commit writes in place (it pushes rows
 *  and flags `deleted`, documents only), so it runs on a copy of the documents: the
 *  file given is a read record or the session's, both shared (my-data.ts readRecord). */
function committed(file: RoadmapFile, plan: DocumentSavePlan): RoadmapFile {
  const next = { ...file, documents: file.documents.map((d) => ({ ...d })) };
  plan.commit(next);
  return next;
}
