// The shared upload's Save for the iPhone (US-52 AC8c, US-14 AC10): health-core `uploadSave`, the
// pick's values and its document and lab archive rows in one step, through the open cloud session
// as documentSave commits, or onto the phone's record text. Swift never touches the cloud: the
// engine writes each original the plan stores, reading its bytes from Swift by file id as it writes
// it. Nothing is logged; a refusal's words never carry a value, a name or a hash.
import { uploadSave, type UploadSaveIO } from '../../packages/health-core/src/upload-save';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import * as z from '../../packages/health-core/src/zod';
import { commit, ERASED, NOT_OPEN, open } from './cloud';
import { oneDocumentSaveAtATime } from './cloud-documents';
import { refuse } from './guarded-edit';
import { isArrayBuffer } from './contract';
import { readState, readUploadRecord, Refused, REFUSAL_WORDS } from './upload-doors';

const SAVE_WORDS = {
  ...REFUSAL_WORDS,
  'invalid-originals': 'The upload\'s files could not be read.',
  'not-open': NOT_OPEN,
  erased: ERASED,
  changed: 'Your record changed while this was saving, so it was not saved. Try again.',
};
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
  return oneDocumentSaveAtATime(() => save(stateJson, recordJson, erase, nowIso, deviceId, originalsJson, readOriginal)
    .catch((error) => refusal(error instanceof Refused ? error.reason : 'engine-error'))
    .then((answer) => JSON.stringify(answer)));
}

async function save(
  stateJson: string, recordJson: string, erase: string, nowIso: string, deviceId: string,
  originalsJson: string, readOriginal: OriginalReader,
): Promise<object> {
  const state = readState(stateJson);
  let mimeTypes: Record<string, string>;
  try { mimeTypes = ORIGINALS.parse(JSON.parse(originalsJson)); } catch { return refusal('invalid-originals'); }
  const at = erase ? open : null;
  /** The session the Save began on is still open, at the erase the screen showed. */
  const gone = () => (open !== at ? refusal('not-open') : at?.session.refuses(erase) ? refusal('erased') : null);
  if (erase && gone()) return gone()!;
  // An original written once is not written again when the Save runs again (below): same file, same ref.
  const landed = new Map<string, string>();
  const io: UploadSaveIO<ArrayBuffer> = {
    holds: (fileId) => fileId in mimeTypes,
    original: (fileId) => {
      const bytes = readOriginal(fileId);
      return isArrayBuffer(bytes) && bytes.byteLength > 0 ? bytes : null;
    },
    mimeType: (fileId) => mimeTypes[fileId] ?? '',
    write: async (ref, bytes, fileId) => {
      if (landed.get(ref) === fileId) return;
      await at!.host.store.writeDocument(ref, new Blob([bytes], { type: io.mimeType(fileId) }));
      landed.set(ref, fileId);
    },
  };
  if (!at) {
    const out = await uploadSave(state, readUploadRecord(recordJson, nowIso, deviceId), nowIso, false, io);
    return out.ok ? { ok: true, record: JSON.stringify(out.file), outcome: out.outcome, unstored: out.unstored } : out;
  }
  // The originals take time: a change that arrives meanwhile (another device's save, merged in) is
  // never written over. The Save runs again on it, once, writing no original twice.
  for (let attempt = 0; attempt < 2; attempt++) {
    const start: RoadmapFile = at.session.file;
    const out = await uploadSave(state, start, nowIso, true, io);
    if (!out.ok) return out;
    if (gone()) return gone()!;
    if (at.session.file !== start) continue;
    if (out.file !== start) {
      const refused = commit(at, out.file, erase, nowIso);
      if (refused) return refused;
    }
    return { ok: true, record: JSON.stringify(at.session.file), erase: at.session.eraseIdentity, outcome: out.outcome, unstored: out.unstored };
  }
  return refusal('changed');
}
