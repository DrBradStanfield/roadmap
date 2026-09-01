/**
 * ChatHistoryStore — chat conversations persisted to the user's OWN cloud as
 * `chat-history.json` (Phase 6), beside health-roadmap.json but a separate
 * file (Brad, firm). Runs the same SyncManager read-merge-write loop as the
 * roadmap store, over the SAME adapter instance, so history survives reload
 * and converges across devices.
 *
 * Consumers: byok-chat.ts (Pages/self-host — replaces the localStorage
 * conversation cache) and chat-api.ts on local-first storefront builds
 * (conversation CRUD; the answer itself still comes from Brad's server).
 * Mutations persist immediately — chat writes are infrequent (one per
 * exchange), so there's no debounce. Callers treat failures as best-effort
 * (history must never break the chat itself).
 */
import {
  CHAT_HISTORY_MAX_CONVERSATIONS,
  mergeChatHistoryFiles,
  mergeMessages,
  migrateChatHistoryFile,
  type ChatFileConversation,
  type ChatFileMessage,
  type ChatHistoryFile,
} from '@roadmap/health-core';
import type { StorageAdapter } from '@roadmap/health-core';
import { getDeviceId } from './device-id';
import { SyncManager, type DocumentSpec } from '@roadmap/health-core';

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
  merge: mergeChatHistoryFiles,
  // History is best-effort at every call site — skip the verify-after-write
  // re-read (H5 protects health-record integrity; here it would spend a full
  // file transfer per exchange guarding data whose loss is already tolerated).
  verify: false,
};

export class ChatHistoryStore {
  private constructor(
    private readonly sync: SyncManager<ChatHistoryFile>,
    private file: ChatHistoryFile,
  ) {}

  /** Load chat history from the given backend and return a ready store. */
  static async create(adapter: StorageAdapter): Promise<ChatHistoryStore> {
    const sync = new SyncManager(adapter, getDeviceId(), CHAT_HISTORY_DOC);
    return new ChatHistoryStore(sync, await sync.load());
  }

  /** Live (non-deleted) conversation summaries, newest first. */
  listConversations(): ChatConversationSummary[] {
    return this.liveConversations().map(({ id, title, createdAt, updatedAt }) => ({
      id,
      title,
      createdAt,
      updatedAt,
    }));
  }

  getMessages(conversationId: string): ChatFileMessage[] {
    const conv = this.file.conversations.find((c) => c.id === conversationId);
    return conv && !conv.deleted ? conv.messages : [];
  }

  /**
   * Persist one chat exchange (the shared tail of both transports): mints the
   * message ids and timestamps, applies the title rule (first user message,
   * truncated, only when the conversation is new), creates the conversation if
   * needed, enforces the cap, and saves to the cloud.
   */
  async recordExchange(opts: {
    conversationId: string;
    /** True when this exchange started the conversation (sets the title). */
    isNew: boolean;
    userText: string;
    assistantText: string;
    /** Server-issued assistant message id, when there is one. */
    assistantMessageId?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const messages: ChatFileMessage[] = [
      { id: `u-${Date.now()}`, role: 'user', content: opts.userText, createdAt: now },
      {
        id: opts.assistantMessageId ?? `a-${Date.now()}`,
        role: 'assistant',
        content: opts.assistantText,
        createdAt: now,
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
      this.enforceCap();
    }
    await this.persist();
  }

  /** Tombstone a conversation (monotonic — merge keeps it deleted everywhere). */
  async deleteConversation(conversationId: string): Promise<void> {
    const conv = this.file.conversations.find((c) => c.id === conversationId);
    if (!conv || conv.deleted) return;
    conv.deleted = true;
    conv.messages = [];
    await this.persist();
  }

  private liveConversations(): ChatFileConversation[] {
    return this.file.conversations
      .filter((c) => !c.deleted)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  /** Tombstone the oldest live conversations beyond the cap (a plain slice
   *  would just resurrect on the next cloud merge — tombstones converge). */
  private enforceCap(): void {
    for (const conv of this.liveConversations().slice(CHAT_HISTORY_MAX_CONVERSATIONS)) {
      conv.deleted = true;
      conv.messages = [];
    }
  }

  private async persist(): Promise<void> {
    this.file = (await this.sync.save(this.file)).file;
  }
}
