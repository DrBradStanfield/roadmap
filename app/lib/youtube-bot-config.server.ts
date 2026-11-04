/**
 * YouTube comment auto-replier: limits and env, read once at module load.
 * Split out of youtube-bot.server.ts (issue #429); that file re-exports
 * PER_VIDEO_REPLY_CAP.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 30 * 60_000; // 30 minutes
export const COMMENTS_PER_TICK = 100;        // YouTube returns up to 100 per page
export const DAILY_REPLY_CAP = 50;           // hard ceiling on posts per day
export const PER_VIDEO_REPLY_CAP = 30; // ceiling per video lifetime
export const COMMENT_MAX_AGE_DAYS = 7;       // ignore comments older than this
export const MIN_WORDS = 5;                  // ≥5 words to be considered substantive
export const CRISIS = /\b(die|suicid\w*|kill (myself|me)|chest pain|can'?t breathe|cannot breathe|overdos\w*)\b/i;

// Multi-turn (follow-up) config — see § Follow-up replies in youtube-bot-pipeline.server.ts.
export const FOLLOWUP_MIN_WORDS = 3;             // follow-ups are naturally shorter ("does it cause blindness?")
export const MAX_CHANNEL_REPLIES_PER_THREAD = 2; // hard cap: initial reply + at most ONE follow-up (screenshot-risk control)
export const FOLLOWUP_THREADS_PER_TICK = 25;     // bound the per-tick comments.list calls
export const YOUTUBE_TIMEOUT_MS = 15_000;        // per Google call; a stalled socket must not hold the tick (US-09 AC31)

export const PLATFORM_YOUTUBE = 'youtube';

/**
 * FK anchor for the shared chat tables (`chat_*.user_id` is NOT NULL and
 * references profiles). Falls back to the Discord bot's pseudonymous profile so
 * YouTube persistence works with no new Supabase setup step — the rows are told
 * apart by `chat_conversations.platform`, not by this ID. Set
 * YOUTUBE_BOT_PROFILE_ID to split them later.
 */
export const BOT_PROFILE_ID = process.env.YOUTUBE_BOT_PROFILE_ID ?? process.env.DISCORD_BOT_PROFILE_ID;

export const CHANNEL_ID = process.env.YOUTUBE_BOT_CHANNEL_ID;
export const CLIENT_ID = process.env.YOUTUBE_BOT_CLIENT_ID;
export const CLIENT_SECRET = process.env.YOUTUBE_BOT_CLIENT_SECRET;
export const REFRESH_TOKEN = process.env.YOUTUBE_BOT_REFRESH_TOKEN;
