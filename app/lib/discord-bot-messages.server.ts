/**
 * Discord bot: message helpers. Channel exclusion, safe replies, reply-parent
 * lookup, mention stripping, error naming and reply splitting. Split out of
 * discord-bot.server.ts (issue #429), which re-exports splitForDiscord.
 */
import type { Message, OmitPartialGroupDMChannel } from 'discord.js';
import { DISCORD_EXCLUDED_CHANNEL_IDS } from './discord-bot-config.server';

export type GuildMessage = OmitPartialGroupDMChannel<Message<boolean>>;

/** In an excluded channel or a thread under one (US-63 AC12). A thread's
 *  `channelId` is its own id, so the parent is checked too; a plain channel's
 *  `parentId` is its category, which never counts. */
export function isExcludedChannel(message: GuildMessage): boolean {
  if (DISCORD_EXCLUDED_CHANNEL_IDS.has(message.channelId)) return true;
  const parentId = message.channel.isThread() ? message.channel.parentId : null;
  return parentId != null && DISCORD_EXCLUDED_CHANNEL_IDS.has(parentId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A code or name kept only when shaped like one (H46); anything else is
 *  'unknown', so no free text rides in a log line or a Sentry tag. */
const shaped = (value: string): string => (/^[\w-]{1,40}$/.test(value) ? value : 'unknown');

/** An error's code as a shaped string, or undefined when it has none. */
function shapedCode(code: unknown): string | undefined {
  return typeof code === 'number' || typeof code === 'string' ? shaped(String(code)) : undefined;
}

/** The error's name, shaped Discord code and HTTP status, never the error itself
 *  (US-09 AC6d): discord.js keeps the body it sent on `requestBody`, so
 *  console.error(err) would put the reply, with any values and the asker's
 *  mention, in the host log. */
export function errorKind(err: unknown): string {
  const { name, code, status } = (err ?? {}) as { name?: unknown; code?: unknown; status?: unknown };
  return [name, shapedCode(code), status].filter((v) => typeof v === 'string' || typeof v === 'number').join(' ') || 'unknown';
}

/** A Sentry tag for an error: its shaped code, or its shaped name when it has none. */
export function errorTag(err: unknown): string {
  const { name, code } = (err ?? {}) as { name?: unknown; code?: unknown };
  return shapedCode(code) ?? (typeof name === 'string' ? shaped(name) : 'unknown');
}

/** A stack frame line that ends in a location: `at [async] [new] fn (path:l:c)` or
 *  `at [async] path:l:c`, the path starting /, node:, file:// or a drive letter. */
const FRAME_LOCATION = String.raw`(?:file:\/\/|node:|\/|[A-Za-z]:\\)[^\s()]+:\d+:\d+`;
const FRAME_LINE = new RegExp(String.raw`^\s+at (?:async )?(?:(?:new )?[^\s()[\]]+(?: \[as [^\s()[\]]+\])? \(${FRAME_LOCATION}\)|${FRAME_LOCATION})$`);

class DiscordHandleError extends Error {}
DiscordHandleError.prototype.name = 'DiscordHandleError';

/** What the message handler's outer catch sends Sentry (US-15 AC62, H47): fixed
 *  words and the original's frame lines only (an allow-list, so a multi-line
 *  message never survives), with no cause and no copied properties. With no
 *  frames, its own stack. */
export function handleFailure(err: unknown): Error {
  const failure = new DiscordHandleError('Discord: handleMessage failed');
  const { stack } = (err ?? {}) as { stack?: unknown };
  const frames = typeof stack === 'string' ? stack.split('\n').filter((line) => FRAME_LINE.test(line)) : [];
  if (frames.length > 0) failure.stack = `${failure.name}: ${failure.message}\n${frames.join('\n')}`;
  return failure;
}

export async function safeReply(message: GuildMessage, text: string): Promise<void> {
  try {
    await message.reply({ content: text, allowedMentions: { repliedUser: false } });
  } catch { /* swallow — we don't want reply errors to re-enter Sentry loop */ }
}

/**
 * If `message` is a reply, fetch the referenced message once and return which of
 * `userIds` authored it. Single Discord API call regardless of how many IDs are
 * checked. Returns an empty Set if the message isn't a reply or the parent is
 * unreachable.
 */
export async function getRepliedToUsers(
  message: GuildMessage,
  userIds: readonly (string | undefined)[],
): Promise<Set<string>> {
  const result = new Set<string>();
  const refId = message.reference?.messageId;
  if (!refId) return result;
  try {
    const referenced = await message.channel.messages.fetch(refId);
    const authorId = referenced.author.id;
    for (const id of userIds) {
      if (id && id === authorId) result.add(id);
    }
  } catch {
    // Reference deleted or unreachable — return empty set
  }
  return result;
}

/**
 * Remove all occurrences of `<@userId>` / `<@!userId>` from a message body so
 * the LLM doesn't have to deal with raw mention tokens.
 */
export function stripBotMention(content: string, botUserId: string): string {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split an LLM response across multiple Discord messages so each is ≤ `max` chars.
 * Prefers paragraph boundaries, then sentences, then words, and only falls back
 * to hard character cuts when all else fails.
 */
export function splitForDiscord(content: string, max: number): string[] {
  if (content.length <= max) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > max) {
    const slice = remaining.slice(0, max);

    // Prefer paragraph > sentence > word boundary, in that order
    let cut = slice.lastIndexOf('\n\n');
    if (cut < max * 0.4) {
      const sentenceCut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      if (sentenceCut > max * 0.4) cut = sentenceCut + 1;
    }
    if (cut < max * 0.4) {
      const spaceCut = slice.lastIndexOf(' ');
      if (spaceCut > max * 0.4) cut = spaceCut;
    }
    if (cut < max * 0.4) cut = max;   // hard cut; response was pathologically long

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
