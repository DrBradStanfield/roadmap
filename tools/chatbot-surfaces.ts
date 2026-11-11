/**
 * The answer harness's surfaces (tools/test-chatbot-matching.ts): the posture
 * block each fixture's `surface` adds, and the YouTube bot's prompt.
 *
 * 'doctor' and 'brand' add app/lib/chat-posture-<surface>.md after the
 * products block, where production's buildSystemBlocks puts it. 'youtube'
 * (US-15 AC56) is the YouTube bot's prompt, built as runPipeline builds it
 * (app/lib/youtube-bot-pipeline.server.ts): production's
 * buildYouTubePlatformContext for the video's post, with its follow-up block
 * when the fixture has history; the doctor posture; articles through
 * preferMasters keeping that post; buildConversationMessages; and no tools.
 * A youtube fixture names `youtube_video` (a post with a video and a body),
 * uses fixed `answer_handles` (the harness's routed path applies preferMasters
 * without the video's post kept, which production never does) and takes no
 * user_context. Its query is the raw comment, as production sends it; history
 * turns carry the "Name: " prefix buildThreadHistory gives them.
 * Not covered: the classifier gate before the answer (SILENT_ON_YOUTUBE), and
 * the router (fixed handles only). The harness lowercases and strips markdown
 * before matching, so `skip_no_reply` or `**SKIP_NO_REPLY**` passes a skip
 * check here, though production skips only on the exact SKIP_NO_REPLY.
 *
 * `saved_chat` (C1) adds the SAVED-CHAT block production sends right after the
 * posture, imported from app/lib/chat-save-answers.ts: 'none' (the iPhone app),
 * 'question-rows' (the tool page's widget), 'transcript' (the bubble and the
 * embed), 'discord' or 'youtube'. A youtube fixture always gets YouTube's, as
 * runPipeline sends it; a brand fixture takes only 'transcript' (microvitamin.com
 * runs the bubble alone), and a user_context fixture any but 'discord' (the app,
 * the widget, the bubble and the embed all send one, US-15 AC10). Left out, it
 * defaults as production would send it (see SAVED_CHAT_DEFAULT).
 */
import fs from 'fs';
import path from 'path';
import { findBlogByVideoId, loadBlogIndex, type BlogIndexEntry } from '../app/lib/blog-index.server';
import { loadBlogArticle, loadMatchedContent } from '../app/lib/matched-content';
import { stripFrontmatter } from '../app/lib/frontmatter';
import { preferMasters } from '../app/lib/router-view';
import { buildYouTubePlatformContext, loadedHandles } from '../app/lib/youtube-context';
import { buildConversationMessages } from '../app/lib/chat.server';
import { DISCORD_SAVED_CHAT, SAVED_CHAT_BY_RETENTION, YOUTUBE_SAVED_CHAT, savedChatBlock } from '../app/lib/chat-save-answers';

type Turn = { role: 'user' | 'assistant'; content: string };
interface SurfaceFixture {
  query: string;
  surface?: string;
  saved_chat?: string;
  youtube_video?: string;
  user_context?: unknown;
  answer_handles?: string[];
  expected?: string[];
}
export interface YouTubeVideo { videoId: string; entry: BlogIndexEntry; body: string }

/** Each surface's posture text, or the first fixture whose surface cannot load. The YouTube bot answers under the doctor posture. */
export function loadPostures(repoRoot: string, queries: SurfaceFixture[]): Map<string, string> | string {
  const postures = new Map<string, string>();
  for (const q of queries) {
    if (q.surface === undefined || postures.has(q.surface)) continue;
    const file = path.join(repoRoot, 'app/lib', `chat-posture-${q.surface === 'youtube' ? 'doctor' : q.surface}.md`);
    if (!['doctor', 'brand', 'youtube'].includes(q.surface) || !fs.existsSync(file)) return `unknown surface "${q.surface}" on: ${q.query}`;
    postures.set(q.surface, fs.readFileSync(file, 'utf-8'));
  }
  return postures;
}

/** The video each youtube fixture names, as loadVideoBody finds it, or the first fixture production could never send. */
export function loadYouTubeVideos<Q extends SurfaceFixture>(queries: Q[]): Map<Q, YouTubeVideo> | string {
  const videos = new Map<Q, YouTubeVideo>();
  for (const q of queries) {
    const youtube = q.surface === 'youtube';
    if (youtube !== (q.youtube_video !== undefined) || (youtube && (q.user_context !== undefined || !q.answer_handles || q.expected))) {
      return `surface "youtube" needs youtube_video and answer_handles, takes no user_context or expected, and only it takes youtube_video, on: ${q.query}`;
    }
    if (!youtube) continue;
    const entry = loadBlogIndex().find(a => a.handle === q.youtube_video);
    const videoId = entry?.youtube?.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1];
    const raw = entry && loadBlogArticle(entry.handle);
    // Production finds the post by its video (loadVideoBody); a second post sharing that video is never picked.
    if (!entry || !videoId || !raw || findBlogByVideoId(videoId)?.handle !== entry.handle) return `youtube_video "${q.youtube_video}" is not a post with a video and a body, on: ${q.query}`;
    videos.set(q, { videoId, entry, body: stripFrontmatter(raw) });
  }
  return videos;
}

const SAVED_CHATS: Record<string, string> = { ...SAVED_CHAT_BY_RETENTION, discord: DISCORD_SAVED_CHAT, youtube: YOUTUBE_SAVED_CHAT };

/** The block a fixture with no saved_chat gets, mirroring the production route that sends its prompt. */
const SAVED_CHAT_DEFAULT = (q: SurfaceFixture): string | undefined =>
  q.surface === 'youtube' ? 'youtube' // youtube-bot-pipeline.server.ts runPipeline, always YouTube's
    : q.surface === 'brand' ? 'transcript' // api.chat.ts with CHAT_SURFACE=brand: microvitamin.com runs only the bubble
      : q.surface === 'doctor' && q.user_context !== undefined ? 'question-rows' // api.chat.ts with localFirst: the tool page's widget turn
        : undefined; // a doctor fixture with no context, or no surface: no block, as before C1

/** Each fixture's SAVED-CHAT block, or the first fixture production could never send it with. */
export function loadSavedChats<Q extends SurfaceFixture>(queries: Q[]): Map<Q, string> | string {
  const blocks = new Map<Q, string>();
  for (const q of queries) {
    const key = q.saved_chat ?? SAVED_CHAT_DEFAULT(q);
    if (key === undefined) continue;
    if (!Object.hasOwn(SAVED_CHATS, key) || q.surface === undefined || (q.surface === 'youtube') !== (key === 'youtube')
      || (q.surface === 'brand' && key !== 'transcript') || (q.user_context !== undefined && key === 'discord')) {
      return `saved_chat "${key}" is not one production sends on surface "${q.surface}", on: ${q.query}`;
    }
    blocks.set(q, savedChatBlock(SAVED_CHATS[key]));
  }
  return blocks;
}

/** Every fixture's surface parts; exits on the first fixture production could never send. */
export function loadSurfaces<Q extends SurfaceFixture>(repoRoot: string, queries: Q[]) {
  const postures = loadPostures(repoRoot, queries), videos = loadYouTubeVideos(queries), savedChats = loadSavedChats(queries);
  for (const problem of [postures, videos, savedChats]) if (typeof problem === 'string') { console.error(problem); process.exit(1); }
  return { postures: postures as Map<string, string>, videos: videos as Map<Q, YouTubeVideo>, savedChats: savedChats as Map<Q, string> };
}

/** What runPipeline sends for this comment: the articles, the platform context and the messages. */
export function youtubeTurn(video: YouTubeVideo, handles: string[], comment: string, history: Turn[], index: BlogIndexEntry[]) {
  // An older post gives way to its masters, but the video's own post stays (US-50 AC14).
  const kept = preferMasters(handles, index, comment, { keep: [video.entry.handle] }).handles;
  const matched = loadMatchedContent(kept);
  // Production's loader returns null when nothing loads, and then no masters count as loaded.
  const loaded = loadedHandles(kept, matched.content ? matched : null);
  return {
    matchedContent: matched.content,
    platformContext: buildYouTubePlatformContext(video.videoId, video.entry, video.body, loaded, history.length > 0),
    messages: buildConversationMessages(history, comment),
  };
}
