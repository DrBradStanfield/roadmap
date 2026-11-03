/**
 * Discord bot: env config, message length and rate limits, read once at
 * module load. Split out of discord-bot.server.ts (issue #429).
 */

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
// "Server ID" in Discord UI = "Guild ID" in Discord API. Same thing.
export const DISCORD_GUILD_ID = process.env.DISCORD_SERVER_ID;
export const DISCORD_BRAD_USER_ID = process.env.DISCORD_DrBradStanfield_USER_ID;
export const DISCORD_BOT_PROFILE_ID = process.env.DISCORD_BOT_PROFILE_ID;
// Bot auto-responds in this channel to any user message. Elsewhere it only
// responds to explicit @mentions. Threads under the dedicated channel inherit
// the opt-in behaviour.
export const DISCORD_DEDICATED_AI_CHANNEL_ID = process.env.DISCORD_DEDICATED_AI_CHANNEL_ID;
// Comma-separated channel IDs where the bot never responds, even if @mentioned.
export const DISCORD_EXCLUDED_CHANNEL_IDS = new Set(
  (process.env.DISCORD_EXCLUDED_CHANNEL_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
);

// ---------------------------------------------------------------------------
// Message length + rate limits
// ---------------------------------------------------------------------------

export const DISCORD_MAX_MESSAGE_CHARS = 2000;     // Discord's own per-message cap
// Used when splitting our outgoing reply. Discord's hard cap is 2000, but the
// first chunk is sent via message.reply() with `<@userId> ${chunk}` prepended,
// which adds ~22 chars for the mention. Using 1950 leaves a safe 50-char buffer
// so the mention prefix can never push the final payload over 2000 (DiscordAPIError[50035]).
export const DISCORD_SPLIT_CHARS = 1950;
export const USER_RATE_LIMIT_MAX = 10;              // 10 msgs per user per hour
export const USER_RATE_LIMIT_WINDOW_MS = 60 * 60_000;
export const USER_RATE_LIMIT_CLEANUP_MS = 15 * 60_000;
export const USER_COOLDOWN_MS = 3_000;              // 3s minimum between responses to one user
export const CONCURRENCY_LIMIT = 3;                 // max concurrent LLM calls
export const QUEUE_MAX_DEPTH = 10;                  // beyond this, reject with friendly message
export const HISTORY_MSG_LIMIT = 20;                // cap per-conversation history sent to LLM
// How recently a user's last conversation must have been touched for a new
// non-reply message to continue it instead of starting fresh. See
// loadRecentConversation() (discord-bot-history.server.ts) for why this is
// user-scoped and deliberately short.
export const RECENT_CONVERSATION_WINDOW_MS = 30 * 60_000; // 30 minutes
const PLATFORM_SHOPIFY = 'shopify';
export const PLATFORM_DISCORD = 'discord';
