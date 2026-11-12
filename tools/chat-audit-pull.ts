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
 *   routing.json      — router decisions per message (the widget's only record of a turn: US-15 AC7)
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
 *   ~/Documents/claude_business.nosync/docs/chat-start-here.md
 */

import fs from 'fs';
import path from 'path';
import { escapeHtml } from './escape-html.mjs';
import { styles, script } from './chat-audit-pull-page';
import { type Message, type RoutingEvent, days, fallbackLabel, fromExisting, outputDir, pullMessages, pullRouting, renderConversations, routingKey, routingOnlyTurns, servedFallback, skipHtml } from './chat-audit-pull-rows';


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

// A markdown link [label](url) as an anchor. Web and mail addresses only: a
// javascript: link from a chat would run on click.
function linkHtml(link: string, label: string, url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : link;
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
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, linkHtml);
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

function renderHtml(messages: Message[], routingById: Map<string, RoutingEvent>): string {
  const convMap = new Map<string, Message[]>();
  for (const m of messages) {
    if (!convMap.has(m.conversation_id)) convMap.set(m.conversation_id, []);
    convMap.get(m.conversation_id)!.push(m);
  }


  const convCount = convMap.size;
  const webTurns = messages.filter(m => (m.platform === 'shopify' || m.platform === 'widget') && m.role === 'user').length;
  const discordTurns = messages.filter(m => m.platform === 'discord' && m.role === 'user').length;
  const youtubeTurns = messages.filter(m => m.platform === 'youtube' && m.role === 'user').length;
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
    // Routing rows too: before US-15 AC52 (2026-11-03) a YouTube fallback or refusal wrote no assistant row, only its match event.
    const hasFallback = msgs.some(servedFallback) || routing.some(r => r.conversation_id === convId && servedFallback(r));
    const hasRouterSkipped = msgs.some(m => {
      const r = routingById.get(m.message_id);
      return r && r.router_skipped === true;
    });

    const turnsHtml = msgs.map(msg => {
      const ts = new Date(msg.created_at).toISOString().slice(11, 19);
      const isUser = msg.role === 'user';
      const route = isUser ? routingById.get(msg.message_id) : null;
      const isFallback = !isUser && servedFallback(msg);

      let routerLine = '';
      if (route) {
        const handles = route.matched_handles?.length
          ? route.matched_handles.map(h => `<span class="handle">${escapeHtml(h)}</span>`).join(' ')
          : '<span class="handle empty">∅ (no match)</span>';
        const cacheStr = route.router_cache_hit ? 'cache hit' : 'cache miss';
        const errorHtml = route.router_error
          ? `<span class="router-error">⚠ ${escapeHtml(route.router_error)}</span>`
          : '';
        // Classifier badge appears alongside router info when the classifier ran.
        // SKIP/ROUTE classes color-code: SKIP = orange (router was bypassed), ROUTE = blue (router fired).
        let classifierHtml = '';
        if (route.classification) {
          const skipped = route.router_skipped === true;
          const cls = skipped ? 'classifier-skip' : 'classifier-route';
          const title = skipped
            ? `Classifier said ${route.classification} — router was bypassed (HONOR_SKIP=true)`
            : `Classifier said ${route.classification} — router fired as normal`;
          classifierHtml = `<span class="classifier-badge ${cls}" title="${escapeHtml(title)}">${escapeHtml(route.classification)}${skipped ? ' · skip' : ''}</span>`;
        }
        routerLine = `<div class="router-meta">${classifierHtml}→ ${handles} <span class="muted">(${route.router_latency_ms ?? '?'}ms, ${cacheStr})</span>${errorHtml}</div>`;
      }

      let modelLine = '';
      if (!isUser && msg.model) {
        modelLine = `<div class="model-meta muted">${escapeHtml(msg.model)} · ${msg.input_tokens ?? '?'}in / ${msg.output_tokens ?? '?'}out tokens</div>`;
      }

      const fallbackBadge = isFallback
        ? `<span class="fallback-badge" title="Main LLM failed, returned empty or declined — this is the substituted line${msg.platform === 'youtube' ? ', never posted on YouTube' : ''}">${fallbackLabel(msg)}</span>`
        : '';

      // Surface the captured cause so the reason is visible in the audit email
      // without cross-referencing Sentry.
      const fallbackCauseLine = isFallback && (msg.failure_mode || msg.error_detail)
        ? `<div class="fallback-cause muted">⚠ ${escapeHtml(msg.failure_mode ?? 'unknown')}${msg.error_detail ? `: ${escapeHtml(msg.error_detail)}` : ''}</div>`
        : '';

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

      return `<section class="turn ${isUser ? 'turn-user' : 'turn-assistant'}${isFallback ? ' turn-fallback' : ''}">
        <div class="turn-header">
          <span class="turn-role">${isUser ? 'User' : 'Assistant'}</span>
          <span class="turn-time muted">${ts}</span>
          ${fallbackBadge}
        </div>
        ${routerLine}
        ${modelLine}
        ${fallbackCauseLine}
        <div class="turn-content">${renderMessageContent(msg.content)}</div>
        ${triage}
      </section>`;
    }).join('');

    conversationsHtml.push(`
      <article class="conv" data-conv-id="${convId}" data-platform="${platform}" data-router-error="${hasRouterError ? '1' : '0'}" data-fallback="${hasFallback ? '1' : '0'}" data-router-skipped="${hasRouterSkipped ? '1' : '0'}" style="--user-tint: ${userColor};">
        <header class="conv-header" tabindex="0" role="button" aria-expanded="false">
          <div class="conv-header-left">
            <span class="conv-num">#${convNum}</span>
            <span class="platform-badge platform-${platform}">${platform === 'widget' ? 'Widget' : platform === 'shopify' ? 'Blog chat' : platform === 'youtube' ? 'YouTube' : 'Discord'}</span>
            <span class="conv-snippet">${snippet}</span>
          </div>
          <div class="conv-header-right">
            <span class="turn-count muted">${turnCount} turn${turnCount === 1 ? '' : 's'}</span>
            ${hasRouterError ? '<span class="router-err-badge" title="Router error in this conversation">router err</span>' : ''}
            ${hasFallback ? '<span class="fallback-badge" title="A fallback message was served in this conversation">fallback</span>' : ''}
            ${hasRouterSkipped ? '<span class="router-skip-badge" title="The pre-router classifier short-circuited at least one turn in this conversation">router skipped</span>' : ''}
            <span class="conv-triage muted" data-conv-triage></span>
            <span class="conv-toggle">▾</span>
          </div>
        </header>
        <div class="conv-body" hidden>
          <div class="conv-meta muted">
            <span>Conv ID: ${convId}</span>
            <span>User ID: ${msgs[0].user_id || 'undefined'}</span>
            <span>Started: ${msgs[0].created_at}</span>
            ${externalId ? `<span>Discord: ${escapeHtml(externalId)}</span>` : ''}
          </div>
          ${turnsHtml}
        </div>
      </article>`);
  }


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
        <span><strong>${youtubeTurns}</strong> YouTube user turns</span>
        ${routing.some(servedFallback) ? `<span><strong>${routing.filter(servedFallback).length}</strong> fallbacks or refusals</span>` : ''}
        ${routing.some(r => r.router_skipped) ? `<span><strong>${routing.filter(r => r.router_skipped).length}</strong> router-skipped</span>` : ''}
      </span></p>
      <p class="triage-counter" id="counter">Reviewed: <strong>0 / ${messages.filter(m => m.role === 'assistant').length}</strong></p>
      <div class="controls">
        <input type="search" id="search" placeholder="Search conversations...">
        <select id="platform-filter" aria-label="Platform filter">
          <option value="all">All platforms</option>
          <option value="shopify">Shopify</option>
          <option value="discord">Discord</option>
          <option value="youtube">YouTube</option>
        </select>
        <select id="triage-filter" aria-label="Triage filter">
          <option value="all">All triage states</option>
          <option value="unreviewed">Has unreviewed turns</option>
          <option value="clean">Has ✓ clean</option>
          <option value="warn">Has ⚠ borderline</option>
          <option value="fail">Has ✗ failure</option>
        </select>
        <label><input type="checkbox" id="router-err-only"> Router errors only</label>
        <label><input type="checkbox" id="fallback-only"> Fallbacks and refusals only</label>
        <label><input type="checkbox" id="router-skipped-only"> Router-skipped only</label>
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

// The widget's turns exist only as routing rows — surface them beside the stored ones.
messages = [...messages, ...routingOnlyTurns(routing)].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
const routingById = new Map(routing.map(r => [routingKey(r), r]));

// Render conversations (MD output — preserved exactly as before)
const md = renderConversations(messages, routingById);
fs.writeFileSync(path.join(outputDir, 'conversations.md'), md);
console.log('Wrote conversations.md');

// Render interactive HTML (skippable via --no-html)
if (!skipHtml) {
  const html = renderHtml(messages, routingById);
  fs.writeFileSync(path.join(outputDir, 'conversations.html'), html);
  console.log('Wrote conversations.html');
}

const convCount = new Set(messages.map(m => m.conversation_id)).size;
const userMsgs = messages.filter(m => m.role === 'user');
const webMsgs = userMsgs.filter(m => m.platform === 'shopify' || m.platform === 'widget');
const discordMsgs = userMsgs.filter(m => m.platform === 'discord');

console.log(`\nSummary:`);
console.log(`  ${convCount} conversations`);
console.log(`  ${webMsgs.length} web user turns`);
console.log(`  ${discordMsgs.length} Discord user turns`);
console.log(`\nNext: open ${path.join(outputDir, skipHtml ? 'conversations.md' : 'conversations.html')} and triage against the 11 quality dimensions.`);
console.log(`See chat-start-here.md for the full audit playbook.`);
