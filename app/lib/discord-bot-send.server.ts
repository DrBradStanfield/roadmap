/**
 * Discord bot: sending an answer split into chunks (US-15 AC62). One path for
 * the answer and the dedup re-send. The loop stops at the first chunk that
 * fails and never retries: discord.js already retries 429, 5xx and network
 * faults, and a chunk once posted is public. Logs and Sentry carry fixed words
 * and the error code only, never chunk text (US-09 AC6d): a DiscordAPIError
 * keeps the body it sent, so the error object itself never goes to Sentry.
 */
import * as Sentry from '@sentry/react-router';
import { PLATFORM_DISCORD } from './discord-bot-config.server';
import { errorKind, errorTag, type GuildMessage } from './discord-bot-messages.server';

export type SentChunk = { id: string; text: string };

/** How a send ended. `stoppedAt` is the 0-based index of the chunk that failed. */
export type SendResult =
  | { kind: 'all-sent'; sent: SentChunk[] }
  | { kind: 'partial'; sent: SentChunk[]; stoppedAt: number }
  | { kind: 'none-sent' };

/** Posts one chunk and returns its Discord id, or null when there is no way to post it. */
export type PostChunk = (text: string, index: number) => Promise<string | null>;

export const CUT_OFF_NOTICE = 'This answer was cut off. Please ask again.';

/** Reports a failed post as fixed words, tags and the shape-checked Discord code (or error name). */
function reportSendFailure(what: string, chunk: 'first' | 'later' | 'notice', err: unknown): void {
  console.error(`${what}:`, errorKind(err));
  Sentry.captureMessage(what, { level: 'error', tags: { platform: PLATFORM_DISCORD, subsystem: 'send', chunk, code: errorTag(err) } });
}

export async function sendChunks(post: PostChunk, chunks: string[]): Promise<SendResult> {
  const sent: SentChunk[] = [];
  for (const [i, text] of chunks.entries()) {
    let id: string | null;
    try {
      id = await post(text, i);
    } catch (err) {
      reportSendFailure('Discord: chunk send failed', i === 0 ? 'first' : 'later', err);
      id = null;
    }
    if (id === null) return i === 0 ? { kind: 'none-sent' } : { kind: 'partial', sent, stoppedAt: i };
    sent.push({ id, text });
  }
  return { kind: 'all-sent', sent };
}

/** Chunk 1 replies to the asker with a mention; later chunks go to the channel.
 *  A channel with no `send` cannot post a later chunk, which counts as a failure. */
export function discordPoster(message: GuildMessage): PostChunk {
  return async (text, index) => {
    if (index === 0) {
      return (await message.reply({ content: `<@${message.author.id}> ${text}`, allowedMentions: { repliedUser: false, users: [message.author.id] } })).id;
    }
    if (!(message.channel.isTextBased() && 'send' in message.channel)) {
      console.error('Discord: chunk send failed: channel has no send');
      Sentry.captureMessage('Discord: channel has no send', { level: 'warning', tags: { platform: PLATFORM_DISCORD, subsystem: 'send', chunk: 'later' } });
      return null;
    }
    return (await message.channel.send({ content: text, allowedMentions: { parse: [] } })).id;
  };
}

/** Sends the chunks; after a partial, tries once to say the answer was cut off.
 *  A failed notice is reported in fixed words and never retried. */
export async function sendAnswer(message: GuildMessage, chunks: string[]): Promise<SendResult> {
  const result = await sendChunks(discordPoster(message), chunks);
  if (result.kind === 'partial') {
    try {
      await message.reply({ content: CUT_OFF_NOTICE, allowedMentions: { repliedUser: false } });
    } catch (err) {
      reportSendFailure('Discord: cut-off notice failed', 'notice', err);
    }
  }
  return result;
}

/** The answer exactly as far as its sent chunks reach, the original separators
 *  included: splitForDiscord trims the whitespace at each cut, so joining the
 *  chunks would not give back what went out. Each sent chunk is a slice of
 *  `content` after the one before (splitForDiscord), so the search always finds it. */
export function sentText(content: string, sent: SentChunk[]): string {
  let end = 0;
  for (const { text } of sent) end = content.indexOf(text, end) + text.length;
  return content.slice(0, end);
}
