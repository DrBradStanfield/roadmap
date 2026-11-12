// chat-audit-pull, part 1 of 3: CLI options and Supabase env, the row types, the paged pull,
// the widget turns kept only as routing rows, and the markdown renderer. These change together
// whenever a row field or a surface changes (see git log). Moved verbatim from chat-audit-pull.ts.
import path from 'path';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/** The user saw a substituted line: a fallback, or a refusal (US-15 AC14: `is_fallback` false, `failure_mode` 'refusal'). */
export const servedFallback = (m: { is_fallback: boolean | null; failure_mode: string | null }) => m.is_fallback === true || m.failure_mode === 'refusal';
/** The badge for a substituted line. On YouTube nobody saw it: the bot posts nothing on a failed turn (US-15 AC52). */
export const fallbackLabel = (m: { platform: string; failure_mode: string | null }) =>
  `${m.failure_mode === 'refusal' ? 'REFUSAL' : 'FALLBACK'}${m.platform === 'youtube' ? ' · not posted' : ''}`;

const args = process.argv.slice(2);
function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

export const days = parseInt(getArg('--days', '5'), 10);
export const fromExisting: string | null = args.includes('--from-existing') ? getArg('--from-existing', '') : null;
export const outputDir = getArg('--output-dir', fromExisting ?? path.join(process.cwd(), 'tmp', `chat-audit-${new Date().toISOString().slice(0, 10)}`));
export const skipHtml = args.includes('--no-html');

// ---------------------------------------------------------------------------
// Supabase client (minimal — no package dependency, uses REST API directly)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!fromExisting && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (unless using --from-existing)');
  console.error('Tip: source the .env file: source .env && npx tsx tools/chat-audit-pull.ts');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  message_id: string;
  created_at: string;
  platform: string;
  external_id: string | null;
  conversation_id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  discord_message_id: string | null;
  /** True when the LLM call failed and we substituted the user-facing fallback message.
   *  Column is NOT NULL DEFAULT FALSE (migration 2026-05-15), so SELECT always returns a boolean. */
  is_fallback: boolean;
  /** Fallback cause: 'api-error' (call threw — 5xx/timeout/network/no-text) or
   *  'empty-response' (200 with whitespace-only content), or 'refusal' (the model
   *  declined; `is_fallback` false, US-15 AC14). Null on success and on rows from
   *  before the 2026-06-11 column-add. */
  failure_mode: string | null;
  /** Raw error string (truncated 500 chars) for api-error fallbacks. Null otherwise. */
  error_detail: string | null;
}

export interface RoutingEvent {
  created_at: string;
  /** Null on widget turns (US-15 AC7: no message row) and on YouTube turns the LLM never answered. */
  message_id: string | null;
  conversation_id: string | null;
  user_id: string;
  /** Null once the daily purge has cleared it — questions are kept 30 days
   *  (US-15 AC7, chat-purge-cron.server.ts). */
  message: string | null;
  /** `platform` names the surface on every row since 2026-09-10 (backfilled). */
  router_context: { platform?: string } | null;
  is_fallback: boolean | null;
  failure_mode: string | null;
  matched_handles: string[] | null;
  router_latency_ms: number | null;
  router_cache_hit: boolean | null;
  router_error: string | null;
  router_raw: unknown;
  /** Pre-router classifier output (migration 2026-05-15). NULL on pre-classifier rows. */
  classification: string | null;
  /** True iff the classifier said SKIP AND the HONOR_SKIP flag was on. */
  router_skipped: boolean | null;
}

// ---------------------------------------------------------------------------
// Pull data
// ---------------------------------------------------------------------------

/**
 * Every row of the window, page by page (US-15 AC54). PostgREST answers one
 * request with at most its max-rows (1000 on Supabase) and a 200, so a single
 * request lost the newest rows without a word. Pages run until one comes back
 * empty, which holds whatever the cap is. `id` breaks ties: rows written in one
 * transaction share `created_at`, and tied rows have no fixed order from one
 * request to the next, so a page boundary could skip one row and repeat another.
 */
async function pullAll<T>(table: string, query: string, what: string): Promise<T[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows: T[] = [];
  for (;;) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?${query}&created_at=gte.${since}&order=created_at.asc,id.asc&offset=${rows.length}`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY!,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!res.ok) {
      throw new Error(`Failed to pull ${what}: ${res.status} ${await res.text()}`);
    }
    const page = await res.json() as T[];
    if (page.length === 0) return rows;
    rows.push(...page);
  }
}

export async function pullMessages(): Promise<Message[]> {
  // Use PostgREST join syntax. is_fallback is nullable to tolerate rows
  // from before the 2026-05-15 column-add migration.
  const raw = await pullAll<{
    id: string;
    created_at: string;
    role: string;
    /** Null once the daily purge has blanked it (US-15 AC8): Shopify rows past
     *  30 days keep their place in the thread but not their words. */
    content: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    discord_message_id: string | null;
    // PostgREST returns null for rows inserted before the column existed (if any
    // slipped in pre-migration). Coerced to false in the map below.
    is_fallback: boolean | null;
    failure_mode: string | null;
    error_detail: string | null;
    user_id: string;
    chat_conversations: { id: string; platform: string; external_id: string | null };
  }>(
    'chat_messages',
    'select=id,created_at,role,content,model,input_tokens,output_tokens,discord_message_id,is_fallback,failure_mode,error_detail,' +
    'chat_conversations!inner(id,platform,external_id)',
    'messages',
  );

  return raw.map(r => ({
    message_id: r.id,
    created_at: r.created_at,
    platform: r.chat_conversations.platform,
    external_id: r.chat_conversations.external_id,
    conversation_id: r.chat_conversations.id,
    user_id: r.user_id,
    role: r.role as 'user' | 'assistant',
    content: r.content ?? PURGED_TEXT,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    discord_message_id: r.discord_message_id,
    is_fallback: r.is_fallback ?? false,
    failure_mode: r.failure_mode ?? null,
    error_detail: r.error_detail ?? null,
  }));
}

export async function pullRouting(): Promise<RoutingEvent[]> {
  return pullAll<RoutingEvent>(
    'chat_match_events',
    'select=created_at,message_id,conversation_id,user_id,message,router_context,is_fallback,failure_mode,matched_handles,router_latency_ms,router_cache_hit,router_error,router_raw,classification,router_skipped',
    'routing',
  );
}

/** What purged text reads as in both renderers. Mirrors PURGED_TEXT in
 *  app/lib/chat-purge-cron.server.ts; this CLI talks to PostgREST directly and
 *  imports nothing from the server, so the string is repeated, not shared. */
const PURGED_TEXT = '[removed after 30 days]';

/** Routing rows join messages by message_id; a row with none (the widget, a
 *  YouTube turn the LLM never answered, or a silent Discord SPAM turn, US-15
 *  AC48) gets a key of its own. */
export const routingKey = (r: RoutingEvent) => r.message_id ?? `routing-${r.created_at}-${r.conversation_id}`;

/**
 * Widget turns have no chat_messages row (US-15 AC7): the telemetry row IS the
 * turn. Present each as a user message so both renderers show it beside the
 * stored surfaces (question verbatim, no reply). Widget rows only: YouTube
 * writes its user row before deciding to answer, so its null-message_id rows
 * would duplicate.
 */
export function routingOnlyTurns(routing: RoutingEvent[]): Message[] {
  return routing
    .filter(r => r.conversation_id && r.router_context?.platform === 'widget')
    .map(r => ({
      message_id: routingKey(r),
      created_at: r.created_at,
      platform: 'widget',
      external_id: null,
      conversation_id: r.conversation_id!,
      user_id: r.user_id,
      role: 'user' as const,
      content: r.message ?? PURGED_TEXT,
      model: null,
      input_tokens: null,
      output_tokens: null,
      discord_message_id: null,
      is_fallback: r.is_fallback ?? false,
      failure_mode: r.failure_mode,
      error_detail: null,
    }));
}

// ---------------------------------------------------------------------------
// Render conversations
// ---------------------------------------------------------------------------

export function renderConversations(messages: Message[], routingById: Map<string, RoutingEvent>): string {
  // Group messages by conversation
  const convMap = new Map<string, Message[]>();
  for (const m of messages) {
    if (!convMap.has(m.conversation_id)) convMap.set(m.conversation_id, []);
    convMap.get(m.conversation_id)!.push(m);
  }


  const lines: string[] = [
    `# Chat Audit — ${days} days ending ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `**Total conversations:** ${convMap.size}`,
    `**Total messages:** ${messages.length}`,
    `**Widget:** ${messages.filter(m => m.platform === 'widget').length} user turns (telemetry only — questions, no replies)`,
    `**Blog chat:** ${messages.filter(m => m.platform === 'shopify' && m.role === 'user').length} user turns`,
    `**Discord:** ${messages.filter(m => m.platform === 'discord' && m.role === 'user').length} user turns`,
    `**YouTube:** ${messages.filter(m => m.platform === 'youtube' && m.role === 'user').length} user turns`,
    ``,
    `---`,
    ``,
  ];

  let convNum = 0;
  for (const [convId, msgs] of convMap) {
    convNum++;
    const platform = msgs[0].platform;
    const externalId = msgs[0].external_id;
    const firstMsg = msgs[0];

    // external_id means a different thing per platform: Discord user ID vs
    // YouTube top-level comment ID. Label it correctly rather than always "Discord".
    const externalLabel = platform === 'youtube' ? 'comment' : platform === 'discord' ? 'Discord' : 'id';
    lines.push(`## Conversation ${convNum} — ${platform.toUpperCase()}${externalId ? ` (${externalLabel}: ${externalId})` : ''}`);
    lines.push(`**ID:** ${convId}`);
    lines.push(`**Time:** ${firstMsg.created_at}`);
    lines.push(`**User ID:** ${firstMsg.user_id}`);
    lines.push(``);

    for (const msg of msgs) {
      const ts = new Date(msg.created_at).toISOString().slice(11, 19);
      const isFallback = msg.role === 'assistant' && servedFallback(msg);
      const role = msg.role === 'user'
        ? '**User**'
        : isFallback ? `**Assistant** · ⚠️ ${fallbackLabel(msg)}` : '**Assistant**';

      // Truncate very long responses for readability
      const content = msg.content.length > 2000
        ? msg.content.slice(0, 2000) + `\n\n*[truncated — ${msg.content.length} chars total]*`
        : msg.content;

      lines.push(`### ${ts} — ${role}`);

      // Show the fallback cause so the reason is visible without Sentry.
      if (isFallback && (msg.failure_mode || msg.error_detail)) {
        lines.push(`*⚠️ ${msg.failure_mode ?? 'unknown'}${msg.error_detail ? `: ${msg.error_detail}` : ''}*`);
        lines.push(``);
      }

      // Show routing for user messages
      if (msg.role === 'user') {
        const route = routingById.get(msg.message_id);
        if (route) {
          const handles = route.matched_handles?.length
            ? route.matched_handles.join(', ')
            : '∅ (no match)';
          const cacheStr = route.router_cache_hit ? 'cache hit' : 'cache miss';
          const errorStr = route.router_error ? ` ⚠️ ERROR: ${route.router_error}` : '';
          lines.push(`*Router → ${handles} (${route.router_latency_ms}ms, ${cacheStr})${errorStr}*`);
          lines.push(``);
        }
      }

      if (msg.model) {
        lines.push(`*Model: ${msg.model} | ${msg.input_tokens ?? '?'}in / ${msg.output_tokens ?? '?'}out tokens*`);
      }

      lines.push(``);
      lines.push(content);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
  }

  return lines.join('\n');
}
