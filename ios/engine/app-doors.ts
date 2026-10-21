// The engine doors for the iPhone app's chat and lab upload (US-52), JSON in
// and out like entry.ts's. Each is health-core's own function: the chat
// context the web widget sends (chatContextOf), the chat history file
// (ChatSession, over an in-memory device host the app's file fills), and the
// lab review and save summary (lab-review.ts, bulkAppendValues).
import { chatContextOf } from '../../packages/health-core/src/chat-context';
import { ChatSession } from '../../packages/health-core/src/chat-session';
import { fileScreeningRows } from '../../packages/health-core/src/file-inputs';
import type { ApiMedication } from '../../packages/health-core/src/mappings';
import { derivePlanInputs } from '../../packages/health-core/src/plan';
import type { RecordHost } from '../../packages/health-core/src/record-host';
import { labReview, labRows, labSaveSummary, type Extraction } from './lab-review';
import { readRecord } from './my-data';

/** What the chat sends with a question (US-52 AC5): the widget's payload, built from the record. */
export function chatContextJson(recordJson: string, nowIso: string, deviceId: string): string {
  const file = readRecord(recordJson, nowIso, deviceId);
  const { inputs, unitSystem } = derivePlanInputs(file);
  const dated = file.measurements.filter((m) => m.status === 'active');
  return JSON.stringify(chatContextOf(inputs, unitSystem, file.medications as unknown as ApiMedication[], fileScreeningRows(file.screenings), dated));
}

// --- Chat history (chat-history.json), through ChatSession -----------------

/**
 * A device-tier host whose store is one in-memory file: the text Swift read
 * from disk goes in, and what the session writes comes out for Swift to save.
 * The session's device path does no I/O of its own, so its promises settle
 * as soon as the engine call returns (see `settledJson`).
 */
function memoryHost(historyText: string | null, nowIso: string, deviceId: string) {
  let body: unknown = historyText ? JSON.parse(historyText) : null;
  let version: string | null = body ? '1' : null;
  const unused = () => { throw new Error('not used on the device tier'); };
  const host = {
    tier: 'device',
    sync: {
      readSync: () => ({ body, version }),
      writeSync: (_name: string, next: object) => { body = next; version = String(Number(version ?? 0) + 1); return { version }; },
      revision: () => version,
    },
    clearNamedFiles: () => {},
    eraseFence: () => null,
    store: { read: unused, write: unused },
    clearOffFileData: () => {},
    deviceId: () => deviceId,
    clock: { now: () => Date.parse(nowIso) },
    timers: { set: unused, clear: () => {} },
    remoteChanged: () => {},
    failureCause: () => 'other',
    report: () => {},
  } as unknown as RecordHost;
  return { host, written: () => body };
}

let settled: string | null = null;

/** Runs an async door; its answer is read with `settledJson` after the call returns. */
export function settle(work: Promise<unknown>): string {
  settled = null;
  work.then(
    (value) => { settled = JSON.stringify({ ok: true, value }); },
    (error: unknown) => { settled = JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'failed' }); },
  );
  return '';
}

/**
 * The last async door's answer: `{ ok, value }` or `{ ok: false, message }`.
 * JavaScriptCore runs pending promise work before an API call returns, so it
 * is ready by the time Swift asks; `pending` means it was not.
 */
export function settledJson(): string {
  return settled ?? JSON.stringify({ ok: false, message: 'pending' });
}

/** The live conversations, newest first. Settles to the summaries. */
export function chatListJson(historyText: string | null, nowIso: string, deviceId: string): string {
  const { host } = memoryHost(historyText, nowIso, deviceId);
  return settle(ChatSession.open(host).then((s) => s.listConversations()));
}

/** One conversation's messages, question before answer (health-core's merge order). Settles to the messages. */
export function chatMessagesJson(historyText: string | null, conversationId: string, nowIso: string, deviceId: string): string {
  const { host } = memoryHost(historyText, nowIso, deviceId);
  return settle(ChatSession.open(host).then((s) => s.getMessages(conversationId)));
}

/** Records one question and answer (the web's rule: title, cap, tombstones). Settles to the new file's text. */
export function chatRecordExchangeJson(historyText: string | null, exchangeJson: string, nowIso: string, deviceId: string): string {
  const { host, written } = memoryHost(historyText, nowIso, deviceId);
  const exchange = JSON.parse(exchangeJson) as Parameters<ChatSession['recordExchange']>[0];
  return settle(ChatSession.open(host).then((s) => s.recordExchange(exchange)).then(() => JSON.stringify(written())));
}

/** Deletes a conversation (a tombstone, as on the web). Settles to the new file's text. */
export function chatDeleteJson(historyText: string | null, conversationId: string, nowIso: string, deviceId: string): string {
  const { host, written } = memoryHost(historyText, nowIso, deviceId);
  return settle(ChatSession.open(host).then((s) => s.deleteConversation(conversationId)).then(() => JSON.stringify(written())));
}

/**
 * Tombstones every conversation for "delete all my data" (US-11 AC2): the
 * web's ChatSession.eraseAll. Resolves to the new file's text, or null when
 * there is no file. Rejects when the file cannot be read.
 */
export async function eraseChatText(historyText: string | null, nowIso: string, deviceId: string): Promise<string | null> {
  const { host, written } = memoryHost(historyText, nowIso, deviceId);
  await (await ChatSession.open(host)).eraseAll();
  const body = written();
  return body == null ? null : JSON.stringify(body);
}

// --- Lab upload review -------------------------------------------------------

/** What the review screen shows for the server's extraction (US-52 AC8). */
export function labReviewJson(extractionJson: string, nowIso: string): string {
  return JSON.stringify(labReview(JSON.parse(extractionJson) as Extraction, nowIso));
}

/** What saving the ticked values would do: `{ ok, summary }` or the refusal. The record is not changed. */
export function labSaveSummaryJson(recordJson: string, extractionJson: string, refsJson: string, reportDay: string, nowIso: string, deviceId: string): string {
  const rows = labRows(JSON.parse(extractionJson) as Extraction, JSON.parse(refsJson) as string[], reportDay, nowIso);
  if (!rows.ok) return JSON.stringify(rows);
  return JSON.stringify({ ok: true, summary: labSaveSummary(readRecord(recordJson, nowIso, deviceId), rows.rows, nowIso) });
}
