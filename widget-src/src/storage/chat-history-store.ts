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
  migrateChatHistoryFile,
  type ChatFileConversation,
  type ChatFileMessage,
  type ChatHistoryFile,
} from '@roadmap/health-core';
import { CHAT_HISTORY_FILE_NAME, type StorageAdapter } from './adapter';
import { getDeviceId } from './device-id';
import { SyncManager, type DocumentSpec } from './sync-manager';

export const CHAT_HISTORY_DOC: DocumentSpec<ChatHistoryFile> = {
  fileName: CHAT_HISTORY_FILE_NAME,
  migrate: migrateChatHistoryFile,
  merge: mergeChatHistoryFiles,
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

  /** Live (non-deleted) conversations, newest first. */
  listConversations(): ChatFileConversation[] {
    return this.file.conversations
      .filter((c) => !c.deleted)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  getMessages(conversationId: string): ChatFileMessage[] {
    const conv = this.file.conversations.find((c) => c.id === conversationId);
    return conv && !conv.deleted ? conv.messages : [];
  }

  /**
   * Append messages to a conversation (creating it if needed), stamp
   * updatedAt, enforce the conversation cap, and persist to the cloud.
   * `title` is applied when creating, or when a non-empty one is supplied
   * (e.g. the server retitled the conversation).
   */
  async appendMessages(opts: {
    conversationId: string;
    title?: string;
    now: string;
    messages: ChatFileMessage[];
  }): Promise<void> {
    const existing = this.file.conversations.find((c) => c.id === opts.conversationId);
    if (existing?.deleted) return; // tombstoned on another device — don't resurrect
    if (existing) {
      const seen = new Set(existing.messages.map((m) => m.id));
      existing.messages = [...existing.messages, ...opts.messages.filter((m) => !seen.has(m.id))];
      existing.updatedAt = opts.now;
      if (opts.title) existing.title = opts.title;
    } else {
      this.file.conversations.push({
        id: opts.conversationId,
        title: opts.title || 'Chat',
        createdAt: opts.now,
        updatedAt: opts.now,
        messages: [...opts.messages],
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

  /** Tombstone the oldest live conversations beyond the cap (a plain slice
   *  would just resurrect on the next cloud merge — tombstones converge). */
  private enforceCap(): void {
    const live = this.listConversations();
    for (const conv of live.slice(CHAT_HISTORY_MAX_CONVERSATIONS)) {
      conv.deleted = true;
      conv.messages = [];
    }
  }

  private async persist(): Promise<void> {
    this.file = (await this.sync.save(this.file)).file;
  }
}
