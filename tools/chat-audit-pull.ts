#!/usr/bin/env tsx
/**
 * Pull N days of chat logs from Supabase and render for human review.
 *
 * Usage:
 *   npx tsx tools/chat-audit-pull.ts
 *   npx tsx tools/chat-audit-pull.ts --days 7
 *   npx tsx tools/chat-audit-pull.ts --days 5 --output-dir /path/to/output
 *
 * Writes three files to --output-dir:
 *   messages.json    — raw pull (includes user IDs — keep local, never commit)
 *   routing.json     — router decisions per message
 *   conversations.md — human-readable conversation rendering for manual audit
 *
 * Requires env vars (copy from roadmap .env):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * See docs for the full audit playbook:
 *   ~/Library/CloudStorage/Dropbox/YouTube/.../claude_business/docs/chat-start-here.md
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const days = parseInt(getArg('--days', '5'), 10);
const outputDir = getArg('--output-dir', path.join(process.cwd(), 'tmp', `chat-audit-${new Date().toISOString().slice(0, 10)}`));

// ---------------------------------------------------------------------------
// Supabase client (minimal — no package dependency, uses REST API directly)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  console.error('Tip: source the .env file: source .env && npx tsx tools/chat-audit-pull.ts');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
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
}

interface RoutingEvent {
  created_at: string;
  message_id: string;
  message: string;
  matched_handles: string[] | null;
  router_latency_ms: number | null;
  router_cache_hit: boolean | null;
  router_error: string | null;
  router_raw: unknown;
}

// ---------------------------------------------------------------------------
// Pull data
// ---------------------------------------------------------------------------

async function pullMessages(): Promise<Message[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Use PostgREST join syntax
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/chat_messages?` +
    `select=id,created_at,role,content,model,input_tokens,output_tokens,discord_message_id,` +
    `chat_conversations!inner(id,platform,external_id)` +
    `&created_at=gte.${since}` +
    `&order=created_at.asc`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY!,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to pull messages: ${res.status} ${await res.text()}`);
  }

  const raw = await res.json() as Array<{
    id: string;
    created_at: string;
    role: string;
    content: string;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    discord_message_id: string | null;
    user_id: string;
    chat_conversations: { id: string; platform: string; external_id: string | null };
  }>;

  return raw.map(r => ({
    message_id: r.id,
    created_at: r.created_at,
    platform: r.chat_conversations.platform,
    external_id: r.chat_conversations.external_id,
    conversation_id: r.chat_conversations.id,
    user_id: r.user_id,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    discord_message_id: r.discord_message_id,
  }));
}

async function pullRouting(): Promise<RoutingEvent[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/chat_match_events?` +
    `select=created_at,message_id,message,matched_handles,router_latency_ms,router_cache_hit,router_error,router_raw` +
    `&created_at=gte.${since}` +
    `&order=created_at.asc`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY!,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to pull routing: ${res.status} ${await res.text()}`);
  }

  return res.json() as Promise<RoutingEvent[]>;
}

// ---------------------------------------------------------------------------
// Render conversations
// ---------------------------------------------------------------------------

function renderConversations(messages: Message[], routing: RoutingEvent[]): string {
  // Group messages by conversation
  const convMap = new Map<string, Message[]>();
  for (const m of messages) {
    if (!convMap.has(m.conversation_id)) convMap.set(m.conversation_id, []);
    convMap.get(m.conversation_id)!.push(m);
  }

  // Build routing lookup by message_id (exact match — avoids collision on duplicate queries)
  const routingById = new Map<string, RoutingEvent>();
  for (const r of routing) {
    routingById.set(r.message_id, r);
  }

  const lines: string[] = [
    `# Chat Audit — ${days} days ending ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `**Total conversations:** ${convMap.size}`,
    `**Total messages:** ${messages.length}`,
    `**Web:** ${messages.filter(m => m.platform === 'shopify' && m.role === 'user').length} user turns`,
    `**Discord:** ${messages.filter(m => m.platform === 'discord' && m.role === 'user').length} user turns`,
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

    lines.push(`## Conversation ${convNum} — ${platform.toUpperCase()}${externalId ? ` (Discord: ${externalId})` : ''}`);
    lines.push(`**ID:** ${convId}`);
    lines.push(`**Time:** ${firstMsg.created_at}`);
    lines.push(`**User ID:** ${firstMsg.user_id}`);
    lines.push(``);

    for (const msg of msgs) {
      const ts = new Date(msg.created_at).toISOString().slice(11, 19);
      const role = msg.role === 'user' ? '**User**' : '**Assistant**';

      // Truncate very long responses for readability
      const content = msg.content.length > 2000
        ? msg.content.slice(0, 2000) + `\n\n*[truncated — ${msg.content.length} chars total]*`
        : msg.content;

      lines.push(`### ${ts} — ${role}`);

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\nChat Audit Pull`);
console.log(`  Days:       ${days}`);
console.log(`  Output dir: ${outputDir}`);
console.log(`  Since:      ${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}\n`);

fs.mkdirSync(outputDir, { recursive: true });

console.log('Pulling messages and routing events...');
const [messages, routing] = await Promise.all([pullMessages(), pullRouting()]);
console.log(`  ${messages.length} messages, ${routing.length} routing events`);

// Write raw JSON
fs.writeFileSync(path.join(outputDir, 'messages.json'), JSON.stringify(messages, null, 2));
fs.writeFileSync(path.join(outputDir, 'routing.json'), JSON.stringify(routing, null, 2));
console.log('\nWrote messages.json and routing.json');

// Render conversations
const md = renderConversations(messages, routing);
fs.writeFileSync(path.join(outputDir, 'conversations.md'), md);
console.log('Wrote conversations.md');

const convCount = new Set(messages.map(m => m.conversation_id)).size;
const userMsgs = messages.filter(m => m.role === 'user');
const webMsgs = userMsgs.filter(m => m.platform === 'shopify');
const discordMsgs = userMsgs.filter(m => m.platform === 'discord');

console.log(`\nSummary:`);
console.log(`  ${convCount} conversations`);
console.log(`  ${webMsgs.length} web user turns`);
console.log(`  ${discordMsgs.length} Discord user turns`);
console.log(`\nNext: open ${path.join(outputDir, 'conversations.md')} and triage against the 11 quality dimensions.`);
console.log(`See chat-start-here.md for the full audit playbook.`);
