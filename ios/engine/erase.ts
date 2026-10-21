// "Delete all my data" while the record is the phone's own file (US-25 AC13,
// US-11). The erase is health-core's buildErasedFile, the rule the web's
// RecordSession.erase writes with; the chat history's is ChatSession.eraseAll.
// The order is the web's (RecordSession.deleteAllData): read the record first,
// so an unreadable one changes nothing; then the chat tombstones, best effort;
// then the record erase. Swift writes both files. A cloud erase is cloud.ts.
import { buildErasedFile } from '../../packages/health-core/src/erase';
import { eraseChatText, settle } from './app-doors';
import { readRecord } from './my-data';

export interface PhoneErase {
  /** The erased record, as text, for Swift to write over the phone's file. */
  record: string;
  /** False when the chat history could not be read: it is left as it was. */
  chatErased: boolean;
  /** The tombstoned chat history to write; null when there is nothing to write. */
  chatHistory: string | null;
}

export async function eraseOnPhone(recordText: string, historyText: string | null, nowIso: string, deviceId: string): Promise<PhoneErase> {
  const ctx = { deviceId, now: nowIso };
  // The phone's file is both the stored record and the working copy: one
  // writer, no device mirror. One it cannot read refuses here, before the chat.
  const stored = readRecord(recordText, nowIso, deviceId);
  let chatErased = false;
  let chatHistory: string | null = null;
  try {
    chatHistory = await eraseChatText(historyText, nowIso, deviceId);
    chatErased = true;
  } catch {
    /* best effort, as on the web: an unreadable chat file never traps the record */
  }
  const record = JSON.stringify(buildErasedFile({ stored, own: stored, device: null, ctx }));
  return { record, chatErased, chatHistory };
}

/** The door Swift calls: settles to the PhoneErase (read it with `settledJson`). */
export function erasePhoneJson(recordText: string, historyText: string | null, nowIso: string, deviceId: string): string {
  return settle(eraseOnPhone(recordText, historyText, nowIso, deviceId));
}
