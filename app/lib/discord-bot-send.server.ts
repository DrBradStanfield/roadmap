/**
 * Discord bot: sending an answer split into chunks (US-15 AC62). One path for
 * the answer and the dedup re-send. The loop stops at the first chunk that
 * fails and never retries: discord.js already retries 429, 5xx and network
 * faults, and a chunk once posted is public. Logs and Sentry tags carry fixed
 * words and the error kind only, never chunk text (US-09 AC6d).
 */
import * as Sentry from '@sentry/react-router';
import { PLATFORM_DISCORD } from './discord-bot-config.server';
import { errorKind, type GuildMessage } from './discord-bot-messages.server';

export type SentChunk = { id: string; text: string };

/** How a send ended. `stoppedAt` is the 0-based index of the chunk that failed. */
export type SendResult =
  | { kind: 'all-sent'; sent: SentChunk[] }
  | { kind: 'partial'; sent: SentChunk[]; stoppedAt: number }
  | { kind: 'none-sent' };

/** Posts one chunk and returns its Discord id, or null when there is no way to post it. */
export type PostChunk = (text: string, index: number) => Promise<string | null>;

export const CUT_OFF_NOTICE = 'This answer was cut off. Please ask again.';

export async function sendChunks(post: PostChunk, chunks: string[]): Promise<SendResult> {
  const sent: SentChunk[] = [];
  for (const [i, text] of chunks.entries()) {
    let id: string | null;
    try {
      id = await post(text, i);
    } catch (err) {
      console.error('Discord: chunk send failed:', errorKind(err));
      Sentry.captureException(err, { tags: { platform: PLATFORM_DISCORD, subsystem: 'send', chunk: i === 0 ? 'first' : 'later' } });
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
      Sentry.captureMessage('Discord: channel has no send', { level: 'warning', tags: { platform: PLATFORM_DISCORD, subsystem: 'send' } });
      return null;
    }
    return (await message.channel.send({ content: text, allowedMentions: { parse: [] } })).id;
  };
}

/** Sends the chunks; after a partial, tries once to say the answer was cut off.
 *  A failed notice is logged in fixed words and never retried. */
export async function sendAnswer(message: GuildMessage, chunks: string[]): Promise<SendResult> {
  const result = await sendChunks(discordPoster(message), chunks);
  if (result.kind === 'partial') {
    try {
      await message.reply({ content: CUT_OFF_NOTICE, allowedMentions: { repliedUser: false } });
    } catch (err) {
      console.error('Discord: cut-off notice failed:', errorKind(err));
    }
  }
  return result;
}
