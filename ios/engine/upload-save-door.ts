// The shared upload's Save for the iPhone (US-52 AC8c, US-14 AC10): health-core `uploadSave`, the
// pick's values and its document and lab archive rows in one step, through the open cloud session
// as documentSave commits, or onto the phone's record text. Swift never touches the cloud: the
// engine writes each original the plan stores, reading its bytes from Swift by file id as it writes
// it, then commits every row on the session's record as it stands then (an edit that landed
// meanwhile is kept). Nothing is logged; a refusal's words never carry a value, a name or a hash.
import { writeMakesFolders } from '../../packages/health-core/src/document-save';
import { uploadSave, type UploadSaveIO } from '../../packages/health-core/src/upload-save';
import { UPLOAD_LIMITS } from '../../packages/health-core/src/upload-rules';
import * as z from '../../packages/health-core/src/zod';
import { commit, ERASED, NOT_OPEN, open } from './cloud';
import { oneDocumentSaveAtATime } from './cloud-documents';
import { refuse } from './guarded-edit';
import { isArrayBuffer } from './contract';
import { readState, readUploadRecord, Refused, REFUSAL_WORDS } from './upload-doors';

const SAVE_WORDS = { ...REFUSAL_WORDS, 'invalid-originals': 'The upload\'s files could not be read.', 'not-open': NOT_OPEN, erased: ERASED };
const refusal = (reason: keyof typeof SAVE_WORDS) => refuse(reason, SAVE_WORDS[reason]);

/** fileId → the original's MIME type, for each file whose bytes Swift holds. */
const ORIGINALS = z.record(z.string(), z.string());
/** Swift's reader of an original's bytes by file id: an ArrayBuffer, or null when it holds none. */
export type OriginalReader = (fileId: string) => unknown;

/** One Save at a time, in the same queue as documentSave: each plans its refs against the record as the last committed it. */
export function uploadSaveRun(
  stateJson: string, recordJson: string, erase: string, nowIso: string, deviceId: string,
  originalsJson: string, readOriginal: OriginalReader,
): Promise<string> {
  // The session this Save is asked of, taken now: one that closes while the Save waits, and another
  // that opens in its place (even at the same erase), is never the one it writes to.
  const asked = erase ? open : null;
  return oneDocumentSaveAtATime(() => save(asked, stateJson, recordJson, erase, nowIso, deviceId, originalsJson, readOriginal)
    .catch((error) => refusal(error instanceof Refused ? error.reason : 'engine-error'))
    .then((answer) => JSON.stringify(answer)));
}

async function save(
  at: typeof open, stateJson: string, recordJson: string, erase: string, nowIso: string, deviceId: string,
  originalsJson: string, readOriginal: OriginalReader,
): Promise<object> {
  const state = readState(stateJson);
  let mimeTypes: Record<string, string>;
  try { mimeTypes = ORIGINALS.parse(JSON.parse(originalsJson)); } catch { return refusal('invalid-originals'); }
  if (erase && (!at || open !== at)) return refusal('not-open');
  const cap = UPLOAD_LIMITS[state.platform].fileBytes;
  /** The session this Save began on is still open, at the erase the screen showed. */
  const gone = () => (open !== at ? refusal('not-open') : at!.session.refuses(erase) ? refusal('erased') : null);
  const io: UploadSaveIO<ArrayBuffer> = {
    holds: (fileId) => Object.hasOwn(mimeTypes, fileId),
    // Anything but an ArrayBuffer under the per-file cap is no original: never held (its row keeps the hash).
    original: (fileId) => {
      const bytes = readOriginal(fileId);
      return isArrayBuffer(bytes) && bytes.byteLength > 0 && bytes.byteLength <= cap ? bytes : null;
    },
    mimeType: (fileId) => mimeTypes[fileId] ?? '',
    makesFolders: !!at && writeMakesFolders(at.host.store.id),
    // Checked with the bytes in hand, right before each write, as the web does (US-11 AC1a): once the
    // erase moves, no further original is written, and the check after the originals answers it.
    write: async (ref, bytes, fileId) => {
      if (gone()) throw new Error('erase moved');
      await at!.host.store.writeDocument(ref, new Blob([bytes], { type: io.mimeType(fileId) }));
    },
  };
  if (!at) {
    const phone = readUploadRecord(recordJson, nowIso, deviceId);
    const out = await uploadSave(state, phone, nowIso, false, io);
    if (!out.ok) return out;
    const { file, outcome } = out.commit(phone);
    return { ok: true, record: JSON.stringify(file), outcome };
  }
  const refusedBefore = gone();
  if (refusedBefore) return refusedBefore;
  const out = await uploadSave(state, at.session.file, nowIso, true, io);
  if (!out.ok) return out;
  const refusedAfter = gone();
  if (refusedAfter) return refusedAfter;
  // The rows land on the session's record as it is now; nothing new commits nothing.
  const current = at.session.file;
  const { file, outcome } = out.commit(current);
  if (file !== current) {
    const refused = commit(at, file, erase, nowIso);
    if (refused) return refused;
  }
  return { ok: true, record: JSON.stringify(at.session.file), erase: at.session.eraseIdentity, outcome };
}
