/**
 * The saved-chat answer per surface (C1), approved by Brad 2026-11-11. Each is
 * sent as a trusted SAVED-CHAT system block after the surface posture, and the
 * model gives it as written (chat-system-prompt.md). Change a sentence only
 * with the storage it describes: retentionOf (chat-retention.ts), the 30-day
 * purge and the question archive (chat-purge-cron.server.ts), and the guide
 * docs/guides/where-your-data-lives.md. The tests pin each pairing.
 */
import type { Retention } from './chat-retention';

export const SAVED_CHAT_BY_RETENTION: Record<Retention, string> = {
  // The iPhone app (US-52 AC5): nothing kept on our server.
  none: "This chat is not kept on our server. Your conversations are saved on this iPhone, beside your record, and left out of its backups. Your question still goes through our server to Anthropic, which writes the answer. The app's privacy notice at drstanfield.com/pages/app-privacy lists what the app sends.",
  // The tool page's widget (US-15 AC7): the masked question row, and the archive copy (AC44).
  'question-rows': "Your health record and tool-page chats are saved in your own storage, not on our server. Our server keeps the text of each chat question for 30 days. If the question is about your health, it also keeps a copy with no end date, to improve the chatbot, after an automatic step tries to remove details that identify you. 'Where your health data lives' lists what it keeps and for how long.",
  // The bubble and the embed (US-15 AC8): the transcript, under the account row when signed in.
  transcript: "This chat is stored on our server. Our server keeps its text for up to 30 days after your last message in it. If you are signed in, it is stored under your account. If a question is about your health, our server also keeps a copy with no end date, to improve the chatbot, after an automatic step tries to remove details that identify you. 'Where your health data lives' lists what it keeps and for how long.",
};

/** The Discord bot: its text is purged 30 days on, and no copy is archived (ARCHIVED_PLATFORMS). */
export const DISCORD_SAVED_CHAT = 'Our server keeps the text of this conversation for up to 30 days after your last message in it. Discord keeps your messages under its own terms.';

/** The YouTube bot: public comments, never purged (PURGED_PLATFORMS). */
export const YOUTUBE_SAVED_CHAT = 'Your comment and this reply are public on YouTube. Our server also keeps a copy of both, with no end date.';

/** The system block buildSystemBlocks places right after the posture. */
export const savedChatBlock = (answer: string) => `## SAVED-CHAT\n\n${answer}`;
