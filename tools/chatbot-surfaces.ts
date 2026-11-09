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
 * Not covered: the classifier gate before the answer (SILENT_ON_YOUTUBE).
 */
import fs from 'fs';
import path from 'path';
import { loadBlogIndex, type BlogIndexEntry } from '../app/lib/blog-index.server';
import { loadBlogArticle, loadMatchedContent } from '../app/lib/matched-content';
import { stripFrontmatter } from '../app/lib/frontmatter';
import { preferMasters } from '../app/lib/router-view';
import { buildYouTubePlatformContext, loadedHandles } from '../app/lib/youtube-context';
import { buildConversationMessages } from '../app/lib/chat.server';

type Turn = { role: 'user' | 'assistant'; content: string };
interface SurfaceFixture {
  query: string;
  surface?: string;
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
    if (!entry || !videoId || !raw) return `youtube_video "${q.youtube_video}" is not a post with a video and a body, on: ${q.query}`;
    videos.set(q, { videoId, entry, body: stripFrontmatter(raw) });
  }
  return videos;
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
