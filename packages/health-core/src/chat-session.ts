/**
 * The chat history session: conversations kept in the user's own storage as
 * `chat-history.json`, beside the health record but a separate file (Brad,
 * firm). Shared by the web widget and the iPhone app (ios/architecture.md
 * D4), over the same RecordHost as the record session. No DOM and no Node:
 * engine-portability.test.ts checks.
 *
 * A cloud runs the SyncManager read-merge-write loop. The device tier is
 * written synchronously, behind the erase fence (US-11 AC3b). Edits persist
 * at once: chat writes are one per exchange, so there is no debounce.
 * Callers treat failures as best-effort (history must never break the chat).
 */
import { ConflictError } from './adapter';
import {
  CHAT_HISTORY_MAX_CONVERSATIONS,
  mergeChatHistoryFiles,
  mergeMessages,
  migrateChatHistoryFile,
  type ChatFileConversation,
  type ChatFileMessage,
  type ChatHistoryFile,
} from './chat-history';
import type { RecordHost, SyncStorage } from './record-host';
import { SyncManager, type DocumentSpec, type SyncContext } from './sync-manager';

/** What the conversation list shows — everything but the message bodies. */
export interface ChatConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const CHAT_HISTORY_DOC: DocumentSpec<ChatHistoryFile> = {
  fileName: 'chat-history.json',
  migrate: migrateChatHistoryFile,
  merge: mergeWithinCap,
  // History is best-effort at every call site — skip the verify-after-write
  // re-read (H5 protects health-record integrity; here it would spend a full
  // file transfer per exchange guarding data whose loss is already tolerated).
  verify: false,
  // Read only by CHECKED_DOC's verify: any conversation the written copy holds
  // deleted (this save's or an earlier one) that the re-read holds live.
  lostWrite: (expected, parsed) => {
    const live = new Set(parsed.conversations.filter((c) => !c.deleted).map((c) => c.id));
    const back = expected.conversations.filter((c) => c.deleted && live.has(c.id)).length;
    return back > 0 ? `${back} deleted conversation(s)` : null;
  },
};

/** A delete or an erase is not tolerated loss: re-read after the write, and
 *  write again if another writer put the conversation back. On Drive, which
 *  has no conditional write, nothing else sees that writer (US-11 AC2d). */
const CHECKED_DOC: DocumentSpec<ChatHistoryFile> = { ...CHAT_HISTORY_DOC, verify: true };

/** A tombstone carries no content: no messages, and no title (it is the user's
 *  own words). The merge enforces the same shape; every local one matches it. */
function tombstone(conv: ChatFileConversation, now?: string): void {
  conv.deleted = true;
  conv.messages = [];
  conv.title = '';
  if (now) conv.updatedAt = now;
}

function liveOf(file: ChatHistoryFile): ChatFileConversation[] {
  return file.conversations
    .filter((c) => !c.deleted)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Every save's merge: the oldest live conversations beyond the cap are
 *  tombstoned by the MERGED copy's updatedAt, never this page's stale one, so
 *  a conversation another device just continued stays (US-10 AC10). A plain
 *  slice would just resurrect on the next cloud merge; tombstones converge. */
function mergeWithinCap(local: ChatHistoryFile, remote: ChatHistoryFile, ctx: SyncContext): ChatHistoryFile {
  const merged = mergeChatHistoryFiles(local, remote, ctx);
  for (const conv of liveOf(merged).slice(CHAT_HISTORY_MAX_CONVERSATIONS)) tombstone(conv);
  return merged;
}

/** The device tier's synchronous store and its erase fence. */
function deviceStore(host: RecordHost): { sync: SyncStorage; fence: () => string | null } | null {
  return host.tier === 'device' ? { sync: host.sync, fence: () => host.eraseFence() } : null;
}

export class ChatSession {
  /** Conversations a device erase removed under this session: an answer that
   *  lands after the erase must not save them again (US-11 AC2). */
  private readonly erasedIds = new Set<string>();
  private readonly device: ReturnType<typeof deviceStore>;

  private constructor(
    private readonly host: RecordHost,
    /** The cloud's loop; null on the device tier, written synchronously. */
    private readonly sync: SyncManager<ChatHistoryFile> | null,
    /** The same loop with verify-after-write, for deletes and the erase. */
    private readonly checked: SyncManager<ChatHistoryFile> | null,
    private file: ChatHistoryFile,
    private fenceSeen: string | null,
  ) {
    this.device = sync ? null : deviceStore(host);
  }

  /** Load chat history from the host's store and return a ready session. */
  static async open(host: RecordHost): Promise<ChatSession> {
    const device = deviceStore(host);
    const ctx = contextOf(host);
    if (device) {
      // Read the content-free erase fence with the chat snapshot. It survives
      // a record removal and parses no health data.
      const fence = device.fence();
      const file = migrateChatHistoryFile(device.sync.readSync(CHAT_HISTORY_DOC.fileName).body, ctx);
      return new ChatSession(host, null, null, file, fence);
    }
    const opts = { now: () => contextOf(host).now };
    const sync = new SyncManager(host.store, ctx.deviceId, CHAT_HISTORY_DOC, opts);
    return new ChatSession(host, sync, new SyncManager(host.store, ctx.deviceId, CHECKED_DOC, opts), await sync.load(), null);
  }

  /** Live (non-deleted) conversation summaries, newest first. */
  listConversations(): ChatConversationSummary[] {
    this.refreshAfterDeviceErase();
    return liveOf(this.file).map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
  }

  getMessages(conversationId: string): ChatFileMessage[] {
    this.refreshAfterDeviceErase();
    const conv = this.file.conversations.find((c) => c.id === conversationId);
    // Read in merge order, so a file saved before the question-first rule
    // (US-52 AC6) reads right before its next save rewrites it.
    return conv && !conv.deleted ? mergeMessages(conv.messages, []) : [];
  }

  /**
   * Persist one chat exchange (the shared tail of both transports): mints the
   * message ids and timestamps, applies the title rule (first user message,
   * truncated, only when the conversation is new), creates the conversation if
   * needed, and saves; the save's merge enforces the cap.
   */
  async recordExchange(opts: {
    conversationId: string;
    /** True when this exchange started the conversation (sets the title). */
    isNew: boolean;
    userText: string;
    assistantText: string;
    /** Server-issued assistant message id, when there is one. */
    assistantMessageId?: string | null;
    /** A fallback or refusal line: stored so the dedup never re-serves it after a reload. */
    isFallback?: boolean;
  }): Promise<void> {
    this.refreshAfterDeviceErase();
    if (this.erasedIds.has(opts.conversationId)) return; // erased while the answer was in flight
    const at = this.host.clock.now();
    const now = new Date(at).toISOString();
    const messages: ChatFileMessage[] = [
      { id: `u-${at}`, role: 'user', content: opts.userText, createdAt: now },
      {
        id: opts.assistantMessageId ?? `a-${at}`,
        role: 'assistant',
        content: opts.assistantText,
        createdAt: now,
        ...(opts.isFallback ? { isFallback: true as const } : {}),
      },
    ];

    const existing = this.file.conversations.find((c) => c.id === opts.conversationId);
    if (existing?.deleted) return; // tombstoned on another device — don't resurrect
    if (existing) {
      existing.messages = mergeMessages(existing.messages, messages);
      existing.updatedAt = now;
    } else {
      this.file.conversations.push({
        id: opts.conversationId,
        title: opts.isNew ? opts.userText.slice(0, 80) : 'Chat',
        createdAt: now,
        updatedAt: now,
        messages,
      });
    }
    await this.persist();
  }

  /** Tombstone a conversation (monotonic — merge keeps it deleted everywhere). */
  async deleteConversation(conversationId: string): Promise<void> {
    this.refreshAfterDeviceErase();
    const conv = this.file.conversations.find((c) => c.id === conversationId);
    if (!conv || conv.deleted) return;
    tombstone(conv);
    await this.persist(true);
  }

  /**
   * Erase every conversation for "delete all my data" (US-11 AC2). Tombstones,
   * not a blank file: the merge unions conversations by id, so an empty file
   * would be resurrected by any other device's copy. `deleted` is monotonic,
   * and the bumped `updatedAt` carries the blanked title through the "newer
   * side wins" rule — the title is the last of the user's own words here.
   */
  async eraseAll(): Promise<void> {
    this.refreshAfterDeviceErase();
    if (this.file.conversations.length === 0) return; // nothing to tombstone
    const now = new Date(this.host.clock.now()).toISOString();
    for (const conv of this.file.conversations) tombstone(conv, now);
    await this.persist(true);
  }

  /** After a device erase, replace the entire stale working copy before
   *  appending new chat. Never merge pre-erase ids into the now-missing file. */
  private refreshAfterDeviceErase(): void {
    if (!this.device) return;
    const fence = this.device.fence();
    if (fence === this.fenceSeen) return;
    for (const conv of this.file.conversations) this.erasedIds.add(conv.id);
    this.file = migrateChatHistoryFile(this.device.sync.readSync(CHAT_HISTORY_DOC.fileName).body, contextOf(this.host));
    this.fenceSeen = fence;
  }

  private async persist(deleted = false): Promise<void> {
    if (this.sync) {
      const result = await (deleted ? this.checked! : this.sync).save(this.file);
      // Merged in, never put in place: a delete made while this save was in
      // the air lives only in the working copy (US-11 AC2b).
      const ctx = contextOf(this.host);
      this.file = mergeChatHistoryFiles(this.file, result.file, ctx);
      return;
    }
    const { sync } = this.device!;
    // Not SyncManager.save: its read and write are awaited, and an erase that
    // lands between them would let this pre-erase snapshot be written back.
    // No await between checking the erase fence, merging and writing.
    for (let attempt = 0; attempt < 5; attempt++) {
      this.refreshAfterDeviceErase();
      const { body, version } = sync.readSync(CHAT_HISTORY_DOC.fileName);
      const ctx = contextOf(this.host);
      const merged = mergeWithinCap(this.file, migrateChatHistoryFile(body, ctx), ctx);
      try {
        sync.writeSync(CHAT_HISTORY_DOC.fileName, merged, version);
        this.file = merged;
        return;
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt === 4) throw error;
      }
    }
  }
}

function contextOf(host: RecordHost): SyncContext {
  return { deviceId: host.deviceId(), now: new Date(host.clock.now()).toISOString() };
}
