/**
 * chat-history.json — the user's chat conversations, synced to THEIR cloud
 * (Phase 6). A SEPARATE file from health-roadmap.json (Brad, firm): chat is
 * high-churn, append-heavy, and not health-record data — keeping it out of the
 * roadmap file keeps both merges simple and both files small.
 *
 * Mirrors the roadmap file's sync envelope (schemaVersion + meta with a lamport
 * clock) so the same SyncManager loop (DocumentSpec) drives it. Merge semantics
 * (modelled on merge.ts `mergeDocuments`):
 *   - conversations union by id
 *   - `deleted` is a MONOTONIC tombstone — once true on any copy, true forever;
 *     a deleted conversation's messages are dropped (tombstones stay cheap)
 *   - within a conversation, messages union by id, ordered by createdAt
 *   - title/updatedAt come from the side whose conversation updated later
 *
 * Forward-compat follows migrate.ts H7: unknown fields are preserved on
 * round-trip; a file written by a NEWER schema refuses to migrate.
 */
import { asArray, isObject, SchemaTooNewError } from './migrate';
import { cmpStr } from './merge';

export const CHAT_HISTORY_SCHEMA_VERSION = 1;

/** Newest conversations kept on write (matches the BYOK localStorage cap). */
export const CHAT_HISTORY_MAX_CONVERSATIONS = 50;

export interface ChatFileMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string; // ISO
}

export interface ChatFileConversation {
  id: string;
  title: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO — last message/edit; drives "newer side wins" fields
  /** Monotonic tombstone — once true on any device, true everywhere forever. */
  deleted?: boolean;
  messages: ChatFileMessage[];
}

export interface ChatHistoryFileMeta {
  createdAt: string;
  updatedAt: string;
  lastDeviceId: string;
  lamport: number;
}

export interface ChatHistoryFile {
  schemaVersion: number;
  meta: ChatHistoryFileMeta;
  conversations: ChatFileConversation[];
}

export function createEmptyChatHistoryFile(opts: { deviceId: string; now: string }): ChatHistoryFile {
  return {
    schemaVersion: CHAT_HISTORY_SCHEMA_VERSION,
    meta: {
      createdAt: opts.now,
      updatedAt: opts.now,
      lastDeviceId: opts.deviceId,
      lamport: 0,
    },
    conversations: [],
  };
}

/**
 * Normalise raw parsed JSON into a complete ChatHistoryFile (the untrusted
 * cloud-read boundary — same contract as migrate.ts `migrateFile`).
 * @throws SchemaTooNewError if the file is from a newer app version.
 */
export function migrateChatHistoryFile(
  raw: unknown,
  opts: { deviceId: string; now: string },
): ChatHistoryFile {
  if (!isObject(raw)) return createEmptyChatHistoryFile(opts);

  const version =
    typeof raw.schemaVersion === 'number' ? raw.schemaVersion : CHAT_HISTORY_SCHEMA_VERSION;
  if (version > CHAT_HISTORY_SCHEMA_VERSION) {
    throw new SchemaTooNewError(version, CHAT_HISTORY_SCHEMA_VERSION);
  }

  const rawMeta = isObject(raw.meta) ? raw.meta : {};
  const conversations: ChatFileConversation[] = asArray<unknown>(raw.conversations)
    .filter((c): c is Record<string, unknown> => isObject(c) && typeof c.id === 'string')
    .map((c) => ({
      ...c,
      id: c.id as string,
      title: typeof c.title === 'string' ? c.title : '',
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : opts.now,
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : opts.now,
      messages: asArray<ChatFileMessage>(c.messages),
    }));

  return {
    // Spread raw FIRST so unknown top-level fields survive a round-trip (H7).
    ...(raw as Record<string, unknown>),
    schemaVersion: CHAT_HISTORY_SCHEMA_VERSION,
    meta: {
      createdAt: typeof rawMeta.createdAt === 'string' ? rawMeta.createdAt : opts.now,
      updatedAt: typeof rawMeta.updatedAt === 'string' ? rawMeta.updatedAt : opts.now,
      lastDeviceId: typeof rawMeta.lastDeviceId === 'string' ? rawMeta.lastDeviceId : opts.deviceId,
      lamport: typeof rawMeta.lamport === 'number' ? rawMeta.lamport : 0,
    },
    conversations,
  } as ChatHistoryFile;
}

/** Union messages by id, ordered by createdAt (then id, for stability).
 *  Shared by the merge below and ChatHistoryStore's local append. */
export function mergeMessages(a: ChatFileMessage[], b: ChatFileMessage[]): ChatFileMessage[] {
  const map = new Map<string, ChatFileMessage>();
  for (const m of [...a, ...b]) {
    if (!map.has(m.id)) map.set(m.id, m);
  }
  return [...map.values()].sort(
    (x, y) => cmpStr(x.createdAt, y.createdAt) || cmpStr(x.id, y.id),
  );
}

function mergeConversation(
  a: ChatFileConversation,
  b: ChatFileConversation,
): ChatFileConversation {
  const newer = a.updatedAt >= b.updatedAt ? a : b;
  const deleted = a.deleted === true || b.deleted === true;
  return {
    // Newer side wins title/updatedAt and unknown per-conversation fields (H7).
    ...newer,
    createdAt: a.createdAt <= b.createdAt ? a.createdAt : b.createdAt,
    ...(deleted ? { deleted: true } : {}),
    // Tombstones stay cheap: a deleted conversation carries no messages.
    messages: deleted ? [] : mergeMessages(a.messages, b.messages),
  };
}

/**
 * Merge `remote` (just read from the cloud) into `local` (this device's working
 * copy). Deterministic and symmetric — same contract as merge.ts `mergeFiles`.
 */
export function mergeChatHistoryFiles(
  local: ChatHistoryFile,
  remote: ChatHistoryFile,
  opts: { deviceId: string; now: string },
): ChatHistoryFile {
  const map = new Map<string, ChatFileConversation>();
  for (const conv of [...remote.conversations, ...local.conversations]) {
    const existing = map.get(conv.id);
    map.set(conv.id, existing ? mergeConversation(existing, conv) : conv);
  }

  return {
    // Spread both first so unknown/future top-level fields are preserved (H7).
    ...remote,
    ...local,
    schemaVersion: Math.max(local.schemaVersion, remote.schemaVersion),
    meta: {
      createdAt:
        local.meta.createdAt < remote.meta.createdAt ? local.meta.createdAt : remote.meta.createdAt,
      updatedAt: opts.now,
      lastDeviceId: opts.deviceId,
      lamport: Math.max(local.meta.lamport, remote.meta.lamport) + 1,
    },
    conversations: [...map.values()].sort((a, b) => cmpStr(a.id, b.id)),
  };
}
