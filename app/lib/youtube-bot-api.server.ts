/**
 * YouTube comment auto-replier: OAuth token refresh and the YouTube Data API
 * calls (list threads and replies, resolve handles, post a reply). Split out
 * of youtube-bot.server.ts (issue #429), which re-exports its public names.
 */
import * as Sentry from '@sentry/react-router';
import {
  CHANNEL_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
  COMMENTS_PER_TICK,
  YOUTUBE_TIMEOUT_MS,
} from './youtube-bot-config.server';
import { classifyPost, type PostResult } from './youtube-bot-post-result';

let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiresAt = 0;

// ---------------------------------------------------------------------------
// OAuth — refresh the access token using the long-lived refresh token
// ---------------------------------------------------------------------------

export async function getAccessToken(): Promise<string> {
  // 60s buffer to avoid mid-request expiry
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      refresh_token: REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }).toString(),
    signal: AbortSignal.timeout(YOUTUBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube OAuth refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

// ---------------------------------------------------------------------------
// YouTube Data API — list recent threads (channel-wide), post reply
// ---------------------------------------------------------------------------

export interface YouTubeThread {
  topLevelCommentId: string;
  videoId: string;
  authorDisplayName: string;
  authorChannelId: string | null;
  text: string;
  publishedAt: string;
  /** commentThreads snippet.canReply; absent on follow-up pseudo-threads. */
  canReply?: boolean;
}

export async function listRecentThreads(token: string): Promise<YouTubeThread[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  url.searchParams.set('allThreadsRelatedToChannelId', CHANNEL_ID!);
  url.searchParams.set('order', 'time');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('maxResults', String(COMMENTS_PER_TICK));
  url.searchParams.set('textFormat', 'plainText');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(YOUTUBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as {
    items?: Array<{
      snippet: {
        videoId: string;
        canReply?: boolean;
        topLevelComment: {
          id: string;
          snippet: {
            authorDisplayName: string;
            authorChannelId?: { value: string };
            textOriginal: string;
            publishedAt: string;
          };
        };
      };
    }>;
  };

  return (data.items ?? []).map(item => {
    const top = item.snippet.topLevelComment;
    return {
      topLevelCommentId: top.id,
      videoId: item.snippet.videoId,
      authorDisplayName: top.snippet.authorDisplayName,
      authorChannelId: top.snippet.authorChannelId?.value ?? null,
      text: top.snippet.textOriginal,
      publishedAt: top.snippet.publishedAt,
      canReply: item.snippet.canReply,
    };
  });
}

export interface YouTubeReply {
  id: string;
  authorDisplayName: string;
  authorChannelId: string | null;
  text: string;
  publishedAt: string;
}

/** List all replies under a top-level comment (YouTube threads are 2-level:
 *  every reply's parentId is the top-level comment, and reply IDs are
 *  `<threadId>.<suffix>`). Sorted oldest-first. */
export async function listReplies(token: string, topLevelCommentId: string): Promise<YouTubeReply[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/comments');
  url.searchParams.set('parentId', topLevelCommentId);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('maxResults', '100');
  url.searchParams.set('textFormat', 'plainText');

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(YOUTUBE_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube replies list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as {
    items?: Array<{
      id: string;
      snippet: {
        authorDisplayName: string;
        authorChannelId?: { value: string };
        textOriginal: string;
        publishedAt: string;
      };
    }>;
  };
  return (data.items ?? [])
    .map(item => ({
      id: item.id,
      authorDisplayName: item.snippet.authorDisplayName,
      authorChannelId: item.snippet.authorChannelId?.value ?? null,
      text: item.snippet.textOriginal,
      publishedAt: item.snippet.publishedAt,
    }))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

/** channelId → "@handle" (null = lookup failed / no handle). Process-lifetime cache. */
const handleCache = new Map<string, string | null>();

/** Resolve a channel's @handle via channels.list → snippet.customUrl. 1 quota unit,
 *  cached per channel. Returns null on any failure — callers must degrade silently. */
export async function resolveHandle(token: string, channelId: string): Promise<string | null> {
  const cached = handleCache.get(channelId);
  if (cached !== undefined) return cached;
  let handle: string | null = null;
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    url.searchParams.set('id', channelId);
    url.searchParams.set('part', 'snippet');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(YOUTUBE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`channels.list ${res.status}`);
    const data = await res.json() as { items?: Array<{ snippet?: { customUrl?: string } }> };
    handle = data.items?.[0]?.snippet?.customUrl ?? null;
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'youtube-bot', subsystem: 'resolve-handle' } });
  }
  handleCache.set(channelId, handle);
  return handle;
}

let cachedChannelHandle: string | null | undefined;

/** The channel's @handle (e.g. "@drbradstanfield") — YouTube auto-prefixes it
 *  when a viewer taps Reply on one of our replies, which is the deterministic
 *  "addressed to the bot" signal. Cached for the process lifetime; null when
 *  the lookup fails (the addressee gate then falls back to original-author-only). */
export async function getChannelHandle(token: string): Promise<string | null> {
  if (cachedChannelHandle === undefined) cachedChannelHandle = await resolveHandle(token, CHANNEL_ID!);
  return cachedChannelHandle;
}

/**
 * Address a follow-up reply to the person who asked.
 *
 * Top-level replies are NOT tagged: YouTube nests them directly under the
 * comment and notifies its author, so an @mention is pure clutter. Follow-ups
 * ARE tagged: YouTube threads are flat (every reply hangs off the top-level
 * comment), so our reply lands at the bottom of the list rather than beside
 * theirs — the @handle is how YouTube's own UI addresses someone in a thread,
 * and it's what reliably notifies a replier who isn't the thread author.
 * Degrades to no prefix when the handle can't be resolved.
 */
export function addressReply(replyText: string, handle: string | null): string {
  if (!handle) return replyText;
  const at = handle.startsWith('@') ? handle : `@${handle}`;
  if (replyText.toLowerCase().startsWith(at.toLowerCase())) return replyText; // already addressed
  return `${at} ${replyText}`;
}

/** Posts a reply. Never throws: the answer is classified (US-27 AC5), and a
 *  timeout or a network error is `unknown`, since Google may have taken it. */
export async function postReply(token: string, parentCommentId: string, text: string): Promise<PostResult> {
  try {
    const res = await fetch('https://www.googleapis.com/youtube/v3/comments?part=snippet', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          parentId: parentCommentId,
          textOriginal: text,
        },
      }),
      signal: AbortSignal.timeout(YOUTUBE_TIMEOUT_MS),
    });
    const result = classifyPost({ status: res.status, body: await res.text() });
    // A 401 means the cached token is bad: the next tick must fetch a fresh one (C15 R3).
    if (result.kind === 'refused' && result.status === 401) cachedAccessToken = null;
    return result;
  } catch (error) {
    return classifyPost({ error });
  }
}
