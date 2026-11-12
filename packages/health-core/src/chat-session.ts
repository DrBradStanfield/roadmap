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
  cutText,
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
  // Read only by checkedDoc's verify: any conversation the written copy holds
  // deleted (this save's or an earlier one) that the re-read does not hold
  // deleted, live or missing. A missing tombstone is lost too: a device that
  // still holds the conversation live would bring it back. The retry merges
  // the tombstones in again, so this cannot loop.
  lostWrite: (expected, parsed) => {
    const stillDeleted = new Set(parsed.conversations.filter((c) => c.deleted).map((c) => c.id));
    const back = expected.conversations.filter((c) => c.deleted && !stillDeleted.has(c.id)).length;
    return back > 0 ? `${back} deleted conversation(s)` : null;
  },
};

/** A delete or an erase is not tolerated loss: re-read after the write, and
 *  write again if another writer put the conversation back. On Drive, which
 *  has no conditional write, nothing else sees that writer (US-11 AC2d).
 *  One spec per save: every attempt merges the same local copy, so the
 *  tombstones an attempt read from the cloud are carried into the next. A
 *  retry would otherwise write a conversation another device deleted back
 *  live, and its verify, which checks only what it wrote, would pass. */
function checkedDoc(): DocumentSpec<ChatHistoryFile> {
  let learned: ChatFileConversation[] = [];
  return {
    ...CHAT_HISTORY_DOC,
    verify: true,
    merge: (local, base, ctx) => {
      // The merge folds an id that appears twice, so a tombstone wins here too.
      const merged = mergeWithinCap({ ...local, conversations: [...local.conversations, ...learned] }, base, ctx);
      learned = merged.conversations.filter((c) => c.deleted);
      return merged;
    },
  };
}

/** A tombstone carries no content: no messages, and no title (it is the user's
 *  own words). The merge enforces the same shape; every local one matches it. */
function tombstone(conv: ChatFileConversation, now?: string): void {
  conv.deleted = true;
  conv.messages = [];
  conv.title = '';
  if (now) conv.updatedAt = now;
}

/** An erase's marker (US-11 AC2h): a conversation-shaped tombstone with an
 *  `erase:` id, born deleted, so every copy unions it and none undoes it. */
const ERASE_MARK = 'erase:';
const isEraseMark = (c: ChatFileConversation): boolean => c.deleted === true && c.id.startsWith(ERASE_MARK);

/** One save's own step, run on the merged file before it is written: on
 *  every attempt, so a retry checks what it read again. */
type MergeStep = (merged: ChatHistoryFile) => void;

function withStep(doc: DocumentSpec<ChatHistoryFile>, step?: MergeStep): DocumentSpec<ChatHistoryFile> {
  if (!step) return doc;
  return { ...doc, merge: (local, base, ctx) => { const merged = doc.merge(local, base, ctx); step(merged); return merged; } };
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
  /** The tail of this session's cloud saves, run one at a time (US-11 AC2e). */
  private saving: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly host: RecordHost,
    /** The cloud's loop; null on the device tier, written synchronously. */
    private readonly sync: SyncManager<ChatHistoryFile> | null,
    /** A fresh loop for one save: its document, with verify-after-write for a delete or an erase. */
    private readonly loop: ((doc: DocumentSpec<ChatHistoryFile>) => SyncManager<ChatHistoryFile>) | null,
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
    return new ChatSession(host, sync, (doc) => new SyncManager(host.store, ctx.deviceId, doc, opts), await sync.load(), null);
  }

  /** Live (non-deleted) conversation summaries, newest first. */
  listConversations(): ChatConversationSummary[] {
    this.refreshAfterDeviceErase();
    return liveOf(this.file).map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
  }

  /**
   * Read the stored file again and merge it into the working copy, after the
   * record's erase moved (US-11 AC2g): another device's erase tombstones then
   * replace the conversations this copy still holds live. Merged, not put in
   * place, so this page's own unsaved tombstones stay. Rejects when the read
   * fails. The device tier re-reads at its erase fence already.
   */
  async reload(): Promise<void> {
    this.refreshAfterDeviceErase();
    if (!this.sync) return;
    const stored = await this.sync.load();
    this.file = mergeChatHistoryFiles(this.file, stored, contextOf(this.host));
  }

  /** The erase markers this copy holds, sorted (US-11 AC2h). A transport
   *  takes them when a question is asked and hands them to recordExchange. */
  eraseMarks(): string[] {
    this.refreshAfterDeviceErase();
    return this.file.conversations.filter(isEraseMark).map((c) => c.id).sort();
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
    /** eraseMarks() when the question was asked. A new conversation is then
     *  saved only if the file it is written into holds no other marker: an
     *  erase that began after the question, on any device (US-11 AC2h). */
    askedMarks?: readonly string[];
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
    let guard: MergeStep | undefined;
    if (existing) {
      existing.messages = mergeMessages(existing.messages, messages);
      existing.updatedAt = now;
    } else {
      if (opts.isNew && opts.askedMarks) guard = this.refuseUnder(opts.conversationId, opts.askedMarks);
      this.file.conversations.push({
        id: opts.conversationId,
        title: opts.isNew ? cutText(opts.userText, 80) : 'Chat', // never half an emoji (US-15 AC26b)
        createdAt: now,
        updatedAt: now,
        messages,
      });
    }
    await this.persist(false, guard);
  }

  /** The new conversation's check, run in each attempt's merge: a marker the
   *  question was not asked under tombstones it in the file about to be
   *  written, and in this copy, so no later save sends it. */
  private refuseUnder(id: string, asked: readonly string[]): MergeStep {
    const seen = new Set(asked);
    return (merged) => {
      if (!merged.conversations.some((c) => isEraseMark(c) && !seen.has(c.id))) return;
      for (const file of [merged, this.file]) {
        const conv = file.conversations.find((c) => c.id === id);
        if (conv) tombstone(conv);
      }
    };
  }

  /** Tombstone a conversation (monotonic — merge keeps it deleted everywhere). */
  async deleteConversation(conversationId: string): Promise<void> {
    this.refreshAfterDeviceErase();
    const conv = this.file.conversations.find((c) => c.id === conversationId);
    // A tombstone already in this copy may never have been stored (a failed
    // save), so a second press writes it again rather than reporting done (US-11 AC2f).
    if (!conv) return;
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
    const now = new Date(this.host.clock.now()).toISOString();
    if (this.sync) {
      // The stored file too, not just this page's copy: another device may
      // have saved conversations since the open (US-11 AC2e). This page's are
      // tombstoned first, so if the read fails the next chat save still
      // sends them. Not on the device tier: the web's record erase removes
      // that file (AC3), and the iPhone opens the file it has just read.
      // Read first, then merge the copy as it is now: a save during the read replaces it.
      for (const conv of this.file.conversations) tombstone(conv);
      const stored = await this.sync.load();
      this.file = mergeChatHistoryFiles(this.file, stored, contextOf(this.host));
      // The marker: a reply to a question asked before it is not saved
      // (US-11 AC2h). Cloud only; the device tier's erase removes the file.
      this.file.conversations.push({ id: `${ERASE_MARK}${crypto.randomUUID()}`, title: '', createdAt: now, updatedAt: now, deleted: true, messages: [] });
    }
    if (this.file.conversations.length === 0) return; // nothing to tombstone
    for (const conv of this.file.conversations) tombstone(conv, now);
    // Every attempt's merge erases what it read too: a conversation another
    // device saved after the read above, or wrote over this one.
    await this.persist(true, (merged) => { for (const conv of liveOf(merged)) tombstone(conv, now); });
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

  private async persist(deleted = false, step?: MergeStep): Promise<void> {
    if (this.sync) {
      // One save at a time: on Drive a write checks, then uploads, so a save
      // still on its way could land after an erase's or a delete's verified
      // write. Each waits for the one before, a failed one too.
      const loop = deleted || step ? this.loop!(withStep(deleted ? checkedDoc() : CHAT_HISTORY_DOC, step)) : this.sync;
      const run = this.saving.then(() => loop.save(this.file));
      this.saving = run.catch(() => undefined);
      const result = await run;
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
      step?.(merged);
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
