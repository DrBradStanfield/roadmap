#!/usr/bin/env tsx
/**
 * Pull N days of chat logs from Supabase and render for human review.
 *
 * Usage:
 *   npx tsx tools/chat-audit-pull.ts
 *   npx tsx tools/chat-audit-pull.ts --days 7
 *   npx tsx tools/chat-audit-pull.ts --days 5 --output-dir /path/to/output
 *   npx tsx tools/chat-audit-pull.ts --from-existing /path/to/audit-dir  # re-render from existing JSON, skip Supabase pull
 *   npx tsx tools/chat-audit-pull.ts --no-html                           # skip the conversations.html output
 *
 * Writes to --output-dir:
 *   messages.json     — raw pull (includes user IDs — keep local, never commit)
 *   routing.json      — router decisions per message
 *   conversations.md  — human-readable conversation rendering for manual audit
 *   conversations.html — interactive triage UI (collapsible cards, ✅/⚠️/❌ buttons,
 *                        per-user color coding, search/filter, localStorage-persisted)
 *
 * Requires env vars (copy from roadmap .env):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * (--from-existing skips the Supabase pull and reads messages.json + routing.json from
 *  the given directory. Useful for iterating on rendering without re-burning DB queries.)
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
const fromExisting: string | null = args.includes('--from-existing') ? getArg('--from-existing', '') : null;
const outputDir = getArg('--output-dir', fromExisting ?? path.join(process.cwd(), 'tmp', `chat-audit-${new Date().toISOString().slice(0, 10)}`));
const skipHtml = args.includes('--no-html');

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
// Render conversations as interactive HTML
// ---------------------------------------------------------------------------

// 11 quality dimensions from chat-start-here.md — used in the triage dropdown
const QUALITY_DIMENSIONS = [
  'Routing correctness',
  'Product accuracy',
  'Account/subscription policy',
  'Citation / DOI integrity',
  'Unprompted supplement mentions',
  'Hallucinations',
  'Clinical safety',
  'Brand voice',
  'Refusal correctness',
  'Multi-turn context',
  'Frustration signals',
];

// Per-user pastel palette (low-saturation, color-blind friendly, accessible contrast for body text)
const USER_PALETTE = [
  '#fef3e2', '#e3f2fd', '#f3e5f5', '#e8f5e9',
  '#fff8e1', '#fce4ec', '#e0f7fa', '#f1f8e9',
];

function hashUserToColor(userId: string | null | undefined): string {
  if (!userId) return USER_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  return USER_PALETTE[Math.abs(hash) % USER_PALETTE.length];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Tiny markdown → HTML for bot responses. Handles: ```code blocks```, `inline code`,
// **bold**, *italic*, # / ## / ### headers, - / * bullets, [link](url), paragraphs.
// Anything else is escaped as plain text. Not a full MD parser — bot replies use a
// limited subset so this is enough.
function renderMessageContent(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  let i = 0;
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  const inline = (text: string): string => {
    let s = escapeHtml(text);
    // code spans first (so other markup inside ` ` doesn't render)
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    // bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic — avoid eating list bullets at start of line; this runs after we've already
    // pulled the line through bullet handling
    s = s.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
    // links — [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      closeLists();
      const lang = line.replace(/^```/, '').trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence (if present)
      const label = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
      out.push(`<pre${label}><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Headers
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      closeLists();
      const level = Math.min(6, h[1].length + 2); // H1→H3, H2→H4 (don't compete with conversation H3)
      out.push(`<h${level} class="msg-h">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered bullets
    const ul = line.match(/^[\-*]\s+(.+)$/);
    if (ul) {
      if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++;
      continue;
    }

    // Ordered list
    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }

    // Blank line ends current block
    if (/^\s*$/.test(line)) {
      closeLists();
      out.push('');
      i++;
      continue;
    }

    // Default: paragraph line
    closeLists();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }

  closeLists();
  return out.filter((_, idx, arr) => !(arr[idx] === '' && arr[idx - 1] === '')).join('\n');
}

function renderHtml(messages: Message[], routing: RoutingEvent[]): string {
  const convMap = new Map<string, Message[]>();
  for (const m of messages) {
    if (!convMap.has(m.conversation_id)) convMap.set(m.conversation_id, []);
    convMap.get(m.conversation_id)!.push(m);
  }

  const routingById = new Map<string, RoutingEvent>();
  for (const r of routing) routingById.set(r.message_id, r);

  const convCount = convMap.size;
  const webTurns = messages.filter(m => m.platform === 'shopify' && m.role === 'user').length;
  const discordTurns = messages.filter(m => m.platform === 'discord' && m.role === 'user').length;
  const endDate = new Date().toISOString().slice(0, 10);

  // Build conversation cards
  let convNum = 0;
  const conversationsHtml: string[] = [];

  for (const [convId, msgs] of convMap) {
    convNum++;
    const platform = msgs[0].platform;
    const externalId = msgs[0].external_id;
    const userColor = hashUserToColor(msgs[0].user_id);
    const firstUserMsg = msgs.find(m => m.role === 'user');
    const snippet = firstUserMsg
      ? escapeHtml(firstUserMsg.content.slice(0, 100).replace(/\s+/g, ' '))
      : '(no user message)';
    const turnCount = msgs.length;
    const hasRouterError = msgs.some(m => {
      const r = routingById.get(m.message_id);
      return r && r.router_error;
    });

    const turnsHtml = msgs.map(msg => {
      const ts = new Date(msg.created_at).toISOString().slice(11, 19);
      const isUser = msg.role === 'user';
      const route = isUser ? routingById.get(msg.message_id) : null;

      let routerLine = '';
      if (route) {
        const handles = route.matched_handles?.length
          ? route.matched_handles.map(h => `<span class="handle">${escapeHtml(h)}</span>`).join(' ')
          : '<span class="handle empty">∅ (no match)</span>';
        const cacheStr = route.router_cache_hit ? 'cache hit' : 'cache miss';
        const errorHtml = route.router_error
          ? `<span class="router-error">⚠ ${escapeHtml(route.router_error)}</span>`
          : '';
        routerLine = `<div class="router-meta">→ ${handles} <span class="muted">(${route.router_latency_ms ?? '?'}ms, ${cacheStr})</span>${errorHtml}</div>`;
      }

      let modelLine = '';
      if (!isUser && msg.model) {
        modelLine = `<div class="model-meta muted">${escapeHtml(msg.model)} · ${msg.input_tokens ?? '?'}in / ${msg.output_tokens ?? '?'}out tokens</div>`;
      }

      const triage = !isUser
        ? `<div class="triage" data-msg-id="${msg.message_id}">
             <button type="button" data-state="clean" class="triage-btn clean" title="Mark clean">✓</button>
             <button type="button" data-state="warn" class="triage-btn warn" title="Mark borderline">!</button>
             <button type="button" data-state="fail" class="triage-btn fail" title="Mark failure">✗</button>
             <select class="dim-select" aria-label="Quality dimension that failed">
               <option value="">— dimension —</option>
               ${QUALITY_DIMENSIONS.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('')}
             </select>
           </div>`
        : '';

      return `<section class="turn ${isUser ? 'turn-user' : 'turn-assistant'}">
        <div class="turn-header">
          <span class="turn-role">${isUser ? 'User' : 'Assistant'}</span>
          <span class="turn-time muted">${ts}</span>
        </div>
        ${routerLine}
        ${modelLine}
        <div class="turn-content">${renderMessageContent(msg.content)}</div>
        ${triage}
      </section>`;
    }).join('');

    conversationsHtml.push(`
      <article class="conv" data-conv-id="${convId}" data-platform="${platform}" data-router-error="${hasRouterError ? '1' : '0'}" style="--user-tint: ${userColor};">
        <header class="conv-header" tabindex="0" role="button" aria-expanded="false">
          <div class="conv-header-left">
            <span class="conv-num">#${convNum}</span>
            <span class="platform-badge platform-${platform}">${platform === 'shopify' ? 'Shopify' : 'Discord'}</span>
            <span class="conv-snippet">${snippet}</span>
          </div>
          <div class="conv-header-right">
            <span class="turn-count muted">${turnCount} turn${turnCount === 1 ? '' : 's'}</span>
            ${hasRouterError ? '<span class="router-err-badge" title="Router error in this conversation">router err</span>' : ''}
            <span class="conv-triage muted" data-conv-triage></span>
            <span class="conv-toggle">▾</span>
          </div>
        </header>
        <div class="conv-body" hidden>
          <div class="conv-meta muted">
            <span>Conv ID: ${convId}</span>
            <span>User ID: ${msgs[0].user_id || 'undefined'}</span>
            <span>Started: ${msgs[0].created_at}</span>
            ${externalId ? `<span>Discord: ${externalId}</span>` : ''}
          </div>
          ${turnsHtml}
        </div>
      </article>`);
  }

  const styles = `
    :root {
      --bg: #fafaf7;
      --text: #1a1a1a;
      --muted: #6b6b6b;
      --border: #e3e3df;
      --primary: #2b5fb0;
      --accent: #b06a2b;
      --success: #2f7a4d;
      --warn: #b07a1a;
      --fail: #a23b3b;
      --card-bg: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--text); background: var(--bg);
    }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px 80px; }
    h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
    .subtitle { color: var(--muted); margin: 0 0 24px; font-size: 13px; }

    .topbar {
      position: sticky; top: 0; z-index: 10;
      background: var(--bg);
      padding-bottom: 12px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .stats { display: flex; flex-wrap: wrap; gap: 16px; margin: 8px 0 12px; font-size: 13px; color: var(--muted); }
    .stats strong { color: var(--text); font-weight: 600; }
    .triage-counter { font-weight: 600; color: var(--text); }
    .triage-counter .ok { color: var(--success); }
    .triage-counter .warn { color: var(--warn); }
    .triage-counter .fail { color: var(--fail); }

    .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .controls input[type="search"], .controls select {
      padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px;
      font: inherit; background: white;
    }
    .controls input[type="search"] { flex: 1; min-width: 200px; }
    .controls label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
    .export-btn {
      padding: 6px 12px; border: 1px solid var(--primary); background: white; color: var(--primary);
      border-radius: 6px; cursor: pointer; font: inherit;
    }
    .export-btn:hover { background: var(--primary); color: white; }

    .conv {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-left: 4px solid var(--user-tint, transparent);
      border-radius: 8px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .conv-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px; cursor: pointer; gap: 12px;
    }
    .conv-header:hover { background: rgba(0,0,0,0.02); }
    .conv-header:focus { outline: 2px solid var(--primary); outline-offset: -2px; }
    .conv-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
    .conv-header-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .conv-num { color: var(--muted); font-weight: 600; font-size: 12px; }
    .platform-badge {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
      white-space: nowrap;
    }
    .platform-shopify { background: #e8f4ff; color: #2b5fb0; }
    .platform-discord { background: #ecebff; color: #5865F2; }
    .conv-snippet {
      color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      flex: 1; min-width: 0;
    }
    .turn-count { font-size: 12px; }
    .router-err-badge {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
      background: #ffe8e8; color: var(--fail); white-space: nowrap;
    }
    .conv-triage[data-conv-triage]:not(:empty) {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
    }
    .conv-toggle { color: var(--muted); transition: transform 150ms; }
    .conv[data-expanded="1"] .conv-toggle { transform: rotate(180deg); }

    .conv-body { padding: 0 16px 16px; border-top: 1px solid var(--border); background: var(--user-tint, transparent); }
    .conv-meta { display: flex; flex-wrap: wrap; gap: 16px; padding: 12px 0; font-size: 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }

    .turn { padding: 12px; margin: 0 0 8px; background: white; border-radius: 6px; }
    .turn-user { background: #f6f5f1; }
    .turn-assistant { background: white; }
    .turn-header { display: flex; gap: 12px; font-size: 12px; margin-bottom: 6px; }
    .turn-role { font-weight: 600; color: var(--text); }
    .turn-time { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
    .muted { color: var(--muted); }
    .router-meta { font-size: 12px; margin: 4px 0; }
    .handle {
      display: inline-block; padding: 1px 6px; margin: 0 2px; border-radius: 3px;
      background: #eef4fc; color: var(--primary); font-family: ui-monospace, monospace; font-size: 11px;
    }
    .handle.empty { background: #f0f0f0; color: var(--muted); }
    .router-error { color: var(--fail); margin-left: 8px; font-weight: 500; }
    .model-meta { font-size: 11px; margin: 2px 0 8px; font-family: ui-monospace, monospace; }
    .turn-content { font-size: 14px; line-height: 1.55; max-width: 75ch; }
    .turn-content p { margin: 0.6em 0; }
    .turn-content p:first-child { margin-top: 0; }
    .turn-content p:last-child { margin-bottom: 0; }
    .turn-content .msg-h { margin: 0.8em 0 0.3em; font-weight: 600; }
    .turn-content h3 { font-size: 16px; }
    .turn-content h4, .turn-content h5, .turn-content h6 { font-size: 14px; }
    .turn-content ul, .turn-content ol { margin: 0.5em 0; padding-left: 1.6em; }
    .turn-content li { margin: 0.15em 0; }
    .turn-content code {
      font: 12.5px ui-monospace, "SF Mono", Menlo, monospace;
      background: #f1efe9; padding: 1px 5px; border-radius: 3px;
    }
    .turn-content pre {
      background: #f1efe9; padding: 10px 12px; border-radius: 6px;
      overflow-x: auto; font-size: 12.5px;
    }
    .turn-content pre code { background: none; padding: 0; }
    .turn-content a { color: var(--primary); }

    .triage { display: flex; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); align-items: center; flex-wrap: wrap; }
    .triage-btn {
      width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border);
      background: white; cursor: pointer; font-weight: 700; font-size: 13px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .triage-btn:hover { transform: scale(1.05); }
    .triage-btn.clean { color: var(--success); }
    .triage-btn.warn { color: var(--warn); }
    .triage-btn.fail { color: var(--fail); }
    .triage-btn[aria-pressed="true"].clean { background: var(--success); color: white; border-color: var(--success); }
    .triage-btn[aria-pressed="true"].warn { background: var(--warn); color: white; border-color: var(--warn); }
    .triage-btn[aria-pressed="true"].fail { background: var(--fail); color: white; border-color: var(--fail); }
    .dim-select { padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; font-size: 12px; background: white; }
    .dim-select:disabled { opacity: 0.4; }

    .conv-triage.t-clean { background: var(--success); color: white; }
    .conv-triage.t-warn { background: var(--warn); color: white; }
    .conv-triage.t-fail { background: var(--fail); color: white; }

    .hidden { display: none !important; }

    @media (max-width: 720px) {
      .container { padding: 16px 10px 60px; }
      .conv-header { flex-wrap: wrap; }
      .conv-snippet { width: 100%; flex: 0 0 auto; padding-top: 4px; }
      .turn-content { font-size: 13px; }
      .controls { flex-direction: column; align-items: stretch; }
      .controls input[type="search"] { width: 100%; }
    }
  `;

  const script = `
    (function () {
      const STORAGE_KEY = 'chat-audit-triage-v1';
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const assistantTurns = document.querySelectorAll('.triage[data-msg-id]');
      const totalAssistant = assistantTurns.length;

      function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

      function updateCounter() {
        let c = 0, w = 0, f = 0;
        for (const id in state) {
          if (state[id].triage === 'clean') c++;
          else if (state[id].triage === 'warn') w++;
          else if (state[id].triage === 'fail') f++;
        }
        const reviewed = c + w + f;
        document.getElementById('counter').innerHTML =
          'Reviewed: <strong>' + reviewed + ' / ' + totalAssistant + '</strong>' +
          ' · <span class="ok">✓ ' + c + '</span>' +
          ' · <span class="warn">! ' + w + '</span>' +
          ' · <span class="fail">✗ ' + f + '</span>';
        document.querySelectorAll('.conv').forEach(updateConvBadge);
      }

      function updateConvBadge(conv) {
        const turns = conv.querySelectorAll('.triage[data-msg-id]');
        let worst = null;
        for (const t of turns) {
          const id = t.dataset.msgId;
          const s = state[id]?.triage;
          if (s === 'fail') { worst = 'fail'; break; }
          if (s === 'warn' && worst !== 'fail') worst = 'warn';
          if (s === 'clean' && !worst) worst = 'clean';
        }
        const badge = conv.querySelector('[data-conv-triage]');
        badge.className = 'conv-triage';
        if (worst === 'clean') { badge.classList.add('t-clean'); badge.textContent = '✓'; }
        else if (worst === 'warn') { badge.classList.add('t-warn'); badge.textContent = '!'; }
        else if (worst === 'fail') { badge.classList.add('t-fail'); badge.textContent = '✗'; }
        else { badge.textContent = ''; }
      }

      function applyState(triage) {
        const id = triage.dataset.msgId;
        const saved = state[id] || {};
        triage.querySelectorAll('.triage-btn').forEach(btn => {
          btn.setAttribute('aria-pressed', btn.dataset.state === saved.triage ? 'true' : 'false');
        });
        const sel = triage.querySelector('.dim-select');
        sel.value = saved.dimension || '';
        sel.disabled = saved.triage !== 'warn' && saved.triage !== 'fail';
      }

      assistantTurns.forEach(triage => {
        applyState(triage);
        triage.querySelectorAll('.triage-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = triage.dataset.msgId;
            const wantState = btn.dataset.state;
            const cur = state[id]?.triage;
            if (cur === wantState) { delete state[id]; }
            else { state[id] = { ...(state[id] || {}), triage: wantState }; }
            saveState();
            applyState(triage);
            updateCounter();
          });
        });
        triage.querySelector('.dim-select').addEventListener('change', e => {
          const id = triage.dataset.msgId;
          state[id] = { ...(state[id] || {}), dimension: e.target.value || undefined };
          if (!state[id].triage && !state[id].dimension) delete state[id];
          saveState();
        });
      });

      // Collapse / expand
      document.querySelectorAll('.conv-header').forEach(h => {
        const toggle = () => {
          const conv = h.closest('.conv');
          const body = conv.querySelector('.conv-body');
          const expanded = body.hidden === false;
          body.hidden = expanded;
          conv.dataset.expanded = expanded ? '0' : '1';
          h.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        };
        h.addEventListener('click', toggle);
        h.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      });

      // Filters
      const searchInput = document.getElementById('search');
      const platformSel = document.getElementById('platform-filter');
      const triageSel = document.getElementById('triage-filter');
      const routerErrChk = document.getElementById('router-err-only');

      function applyFilters() {
        const q = searchInput.value.toLowerCase();
        const plat = platformSel.value;
        const triageF = triageSel.value;
        const errOnly = routerErrChk.checked;

        document.querySelectorAll('.conv').forEach(conv => {
          let show = true;
          if (plat !== 'all' && conv.dataset.platform !== plat) show = false;
          if (errOnly && conv.dataset.routerError !== '1') show = false;
          if (q && !conv.textContent.toLowerCase().includes(q)) show = false;
          if (triageF !== 'all') {
            const turns = conv.querySelectorAll('.triage[data-msg-id]');
            const states = [...turns].map(t => state[t.dataset.msgId]?.triage || 'none');
            const has = (s) => states.includes(s);
            if (triageF === 'unreviewed' && !has('none')) show = false;
            if (triageF === 'clean' && !has('clean')) show = false;
            if (triageF === 'warn' && !has('warn')) show = false;
            if (triageF === 'fail' && !has('fail')) show = false;
          }
          conv.classList.toggle('hidden', !show);
        });
      }
      searchInput.addEventListener('input', applyFilters);
      platformSel.addEventListener('change', applyFilters);
      triageSel.addEventListener('change', applyFilters);
      routerErrChk.addEventListener('change', applyFilters);

      // Export
      document.getElementById('export-btn').addEventListener('click', () => {
        const lines = ['# Triage summary — ' + new Date().toISOString().slice(0, 10), ''];
        let c = 0, w = 0, f = 0;
        const fails = [];
        const warns = [];
        document.querySelectorAll('.triage[data-msg-id]').forEach(triage => {
          const id = triage.dataset.msgId;
          const s = state[id];
          if (!s?.triage) return;
          if (s.triage === 'clean') c++;
          else if (s.triage === 'warn') { w++; warns.push({ id, dim: s.dimension }); }
          else if (s.triage === 'fail') { f++; fails.push({ id, dim: s.dimension }); }
        });
        lines.push('**Counts:** ✓ ' + c + '  ·  ⚠ ' + w + '  ·  ✗ ' + f);
        lines.push('');
        if (fails.length) {
          lines.push('## ❌ Failures');
          fails.forEach(x => lines.push('- ' + x.id + (x.dim ? ' — ' + x.dim : '')));
          lines.push('');
        }
        if (warns.length) {
          lines.push('## ⚠️ Borderlines');
          warns.forEach(x => lines.push('- ' + x.id + (x.dim ? ' — ' + x.dim : '')));
        }
        const text = lines.join('\\n');
        navigator.clipboard.writeText(text).then(() => {
          const btn = document.getElementById('export-btn');
          const old = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = old; }, 1200);
        });
      });

      updateCounter();
    })();
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chat Audit — ${endDate}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="container">
    <div class="topbar">
      <h1>Chat Audit — ${days} day${days === 1 ? '' : 's'} ending ${endDate}</h1>
      <p class="subtitle"><span class="stats">
        <span><strong>${convCount}</strong> conversations</span>
        <span><strong>${messages.length}</strong> messages</span>
        <span><strong>${webTurns}</strong> web user turns</span>
        <span><strong>${discordTurns}</strong> Discord user turns</span>
      </span></p>
      <p class="triage-counter" id="counter">Reviewed: <strong>0 / ${messages.filter(m => m.role === 'assistant').length}</strong></p>
      <div class="controls">
        <input type="search" id="search" placeholder="Search conversations...">
        <select id="platform-filter" aria-label="Platform filter">
          <option value="all">All platforms</option>
          <option value="shopify">Shopify</option>
          <option value="discord">Discord</option>
        </select>
        <select id="triage-filter" aria-label="Triage filter">
          <option value="all">All triage states</option>
          <option value="unreviewed">Has unreviewed turns</option>
          <option value="clean">Has ✓ clean</option>
          <option value="warn">Has ⚠ borderline</option>
          <option value="fail">Has ✗ failure</option>
        </select>
        <label><input type="checkbox" id="router-err-only"> Router errors only</label>
        <button type="button" class="export-btn" id="export-btn">Copy triage as markdown</button>
      </div>
    </div>
    <main>${conversationsHtml.join('')}</main>
  </div>
  <script>${script}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\nChat Audit Pull`);
if (fromExisting) {
  console.log(`  Mode:       --from-existing (skip Supabase, re-render from JSON)`);
  console.log(`  Source dir: ${fromExisting}`);
} else {
  console.log(`  Days:       ${days}`);
  console.log(`  Since:      ${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}`);
}
console.log(`  Output dir: ${outputDir}`);
console.log(`  HTML:       ${skipHtml ? 'no (--no-html)' : 'yes'}\n`);

fs.mkdirSync(outputDir, { recursive: true });

let messages: Message[];
let routing: RoutingEvent[];

if (fromExisting) {
  messages = JSON.parse(fs.readFileSync(path.join(fromExisting, 'messages.json'), 'utf-8')) as Message[];
  routing = JSON.parse(fs.readFileSync(path.join(fromExisting, 'routing.json'), 'utf-8')) as RoutingEvent[];
  console.log(`Loaded ${messages.length} messages, ${routing.length} routing events from existing JSON`);
} else {
  console.log('Pulling messages and routing events...');
  [messages, routing] = await Promise.all([pullMessages(), pullRouting()]);
  console.log(`  ${messages.length} messages, ${routing.length} routing events`);

  // Write raw JSON (only on fresh pulls — --from-existing keeps the source untouched)
  fs.writeFileSync(path.join(outputDir, 'messages.json'), JSON.stringify(messages, null, 2));
  fs.writeFileSync(path.join(outputDir, 'routing.json'), JSON.stringify(routing, null, 2));
  console.log('\nWrote messages.json and routing.json');
}

// Render conversations (MD output — preserved exactly as before)
const md = renderConversations(messages, routing);
fs.writeFileSync(path.join(outputDir, 'conversations.md'), md);
console.log('Wrote conversations.md');

// Render interactive HTML (skippable via --no-html)
if (!skipHtml) {
  const html = renderHtml(messages, routing);
  fs.writeFileSync(path.join(outputDir, 'conversations.html'), html);
  console.log('Wrote conversations.html');
}

const convCount = new Set(messages.map(m => m.conversation_id)).size;
const userMsgs = messages.filter(m => m.role === 'user');
const webMsgs = userMsgs.filter(m => m.platform === 'shopify');
const discordMsgs = userMsgs.filter(m => m.platform === 'discord');

console.log(`\nSummary:`);
console.log(`  ${convCount} conversations`);
console.log(`  ${webMsgs.length} web user turns`);
console.log(`  ${discordMsgs.length} Discord user turns`);
console.log(`\nNext: open ${path.join(outputDir, skipHtml ? 'conversations.md' : 'conversations.html')} and triage against the 11 quality dimensions.`);
console.log(`See chat-start-here.md for the full audit playbook.`);
