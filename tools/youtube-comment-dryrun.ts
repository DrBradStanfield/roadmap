#!/usr/bin/env tsx
/**
 * YouTube comment dry-run — preview what the bot WOULD reply, no posting.
 *
 * Pulls real comments from a YouTube video, runs them through the exact
 * production chatbot pipeline (classifier → conditional router → main LLM
 * with cached blocks 1-3 + the matching blog post as platform-context),
 * and writes an HTML preview page. Brad reviews the preview to validate
 * the bot's selections + reply quality before we ship the auto-poster.
 *
 * Reuses the same prompt files production reads:
 *   - app/lib/chat-classifier-prompt.md
 *   - app/lib/chat-router-prompt.md (via test-chatbot-matching pattern)
 *   - app/lib/chat-system-prompt.md
 *   - docs/products.md
 *   - health_roadmap_algorithm.md
 *   - docs/blog/index.json (router handle index)
 *   - docs/blog/<slug>.md (per-video platform-context, looked up by youtube: frontmatter)
 *
 * Auth for YouTube comment fetch: shells out to claude_business/tools/youtube-analytics.js
 * (read-only OAuth as b.d.stanfield@gmail.com — same token used for analytics).
 *
 * Usage:
 *   source .env && npx tsx tools/youtube-comment-dryrun.ts <videoUrlOrId>
 *   source .env && npx tsx tools/youtube-comment-dryrun.ts https://youtu.be/cFF5KV5hFsU
 *   source .env && npx tsx tools/youtube-comment-dryrun.ts cFF5KV5hFsU --limit 30
 *
 * Output: tools/output/youtube-dryrun-<videoId>.html
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadBlogIndex, findBlogByVideoId, type BlogIndexEntry } from '../app/lib/blog-index.server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CLAUDE_BUSINESS_TOOLS = '/Users/bradstanfield/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/tools';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const videoArg = args.find(a => !a.startsWith('--')) ?? '';
const limit = parseInt(getArg('--limit', '50'), 10);
const concurrency = Math.max(1, parseInt(getArg('--concurrency', '3'), 10));

if (!videoArg) {
  console.error('Usage: npx tsx tools/youtube-comment-dryrun.ts <videoUrlOrId> [--limit 50] [--concurrency 3]');
  process.exit(1);
}

// Extract video ID from URL forms or accept raw ID
function extractVideoId(input: string): string {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  throw new Error(`Could not extract video ID from: ${input}`);
}

const VIDEO_ID = extractVideoId(videoArg);

const apiKey = process.env.ANTHROPIC_TEST_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_TEST_API_KEY or ANTHROPIC_API_KEY must be set');
  process.exit(1);
}
const usingTestKey = !!process.env.ANTHROPIC_TEST_API_KEY;

// ---------------------------------------------------------------------------
// Load prompts + cached blocks (same files production reads)
// ---------------------------------------------------------------------------

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const ROUTER_MODEL = 'claude-haiku-4-5-20251001';
const MAIN_LLM_MODEL = 'claude-haiku-4-5-20251001';

const CLASSIFIER_PROMPT = fs.readFileSync(path.join(REPO_ROOT, 'app/lib/chat-classifier-prompt.md'), 'utf-8');
const ROUTER_PROMPT = fs.readFileSync(path.join(REPO_ROOT, 'app/lib/chat-router-prompt.md'), 'utf-8');
const SYSTEM_PROMPT = fs.readFileSync(path.join(REPO_ROOT, 'app/lib/chat-system-prompt.md'), 'utf-8');
const YOUTUBE_PROMPT_TEMPLATE = fs.readFileSync(path.join(REPO_ROOT, 'app/lib/chat-youtube-prompt.md'), 'utf-8');
const ALGORITHM_DOC = fs.readFileSync(path.join(REPO_ROOT, 'health_roadmap_algorithm.md'), 'utf-8');
const PRODUCTS_DOC = fs.readFileSync(path.join(REPO_ROOT, 'docs/products.md'), 'utf-8');

const BLOG_INDEX: BlogIndexEntry[] = loadBlogIndex();
const VALID_HANDLES = new Set(BLOG_INDEX.map(e => e.handle));

// Router index block (one line per entry, same construction as production)
const TYPE_ORDER: Record<string, number> = { reference: 0, guideline: 1, pathway: 2, article: 3 };
const ROUTER_INDEX_BLOCK = `# KB Index\n\n${[...BLOG_INDEX]
  .sort((a, b) => {
    const ta = TYPE_ORDER[a.type ?? 'article'] ?? 3;
    const tb = TYPE_ORDER[b.type ?? 'article'] ?? 3;
    return ta - tb || a.handle.localeCompare(b.handle);
  })
  .map(e => `[${e.type ?? 'article'}] ${e.handle}: ${e.summary ?? e.title}`)
  .join('\n')}`;

// ---------------------------------------------------------------------------
// Look up matching blog post by youtube: frontmatter via shared blog-index
// ---------------------------------------------------------------------------

interface BlogPost {
  slug: string;
  title: string;
  body: string;
}

function loadBlogPostForVideo(videoId: string): BlogPost {
  const entry = findBlogByVideoId(videoId);
  if (!entry) {
    throw new Error(`No blog post found for video ${videoId} — no entry in docs/blog/index.json has a 'youtube:' field with this video.`);
  }
  const filepath = path.join(REPO_ROOT, 'docs/blog', `${entry.handle}.md`);
  const content = fs.readFileSync(filepath, 'utf-8');
  return {
    slug: entry.handle,
    title: entry.title,
    body: content.replace(/^---[\s\S]*?---\n\n?/, ''),
  };
}

// ---------------------------------------------------------------------------
// Fetch comments via the existing read-only YouTube tool
// ---------------------------------------------------------------------------

interface YouTubeComment {
  author: string;
  text: string;
  likes: number;
  replyCount: number;
  publishedAt: string;
}

function fetchComments(videoId: string, count: number): YouTubeComment[] {
  const result = spawnSync('node', [
    path.join(CLAUDE_BUSINESS_TOOLS, 'youtube-analytics.js'),
    'comments',
    videoId,
    '--count',
    String(count),
  ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

  if (result.status !== 0) {
    throw new Error(`YouTube fetch failed: ${result.stderr}\n${result.stdout}`);
  }

  // The tool prints human-readable to stdout and JSON to stderr (per its source).
  // Find the first '[' in stderr and parse from there.
  const stderr = result.stderr;
  const jsonStart = stderr.indexOf('[');
  if (jsonStart === -1) throw new Error(`No JSON found in YouTube tool stderr:\n${stderr}`);
  const jsonText = stderr.slice(jsonStart);
  return JSON.parse(jsonText) as YouTubeComment[];
}

// ---------------------------------------------------------------------------
// Filter logic — mirrors production rules
// ---------------------------------------------------------------------------

interface FilterDecision {
  keep: boolean;
  reason?: string;
}

function filterComment(c: YouTubeComment): FilterDecision {
  const text = c.text.trim();
  // Top-level only (we don't pass replies to this loop — fetchComments already
  // returns only top-level threads).
  if (!text) return { keep: false, reason: 'empty' };
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 5) return { keep: false, reason: `too short (${wordCount} words)` };
  // Brad's own channel — if we knew his author display name we'd skip it. The
  // YouTube API's authorChannelId would be the deterministic check; for the
  // dry-run we treat "Dr Brad Stanfield" as Brad's display name and skip those.
  if (/^Dr\.?\s*Brad\s*Stanfield$/i.test(c.author.trim())) return { keep: false, reason: "Brad's own comment" };
  return { keep: true };
}

// ---------------------------------------------------------------------------
// Pipeline: classifier → conditional router → main LLM
// ---------------------------------------------------------------------------

async function callAnthropic(body: object): Promise<{ ok: boolean; text: string; raw: any }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, text: '', raw: { status: res.status, error: errBody.slice(0, 300) } };
  }
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find(c => c.type === 'text')?.text ?? '';
  return { ok: true, text, raw: data };
}

async function classify(comment: string): Promise<{ classification: string; raw: string }> {
  const body = {
    model: CLASSIFIER_MODEL,
    max_tokens: 5,
    temperature: 0,
    system: [{ type: 'text', text: CLASSIFIER_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `(new conversation, no prior turns)\n\nCurrent message: ${comment}\n\nClassification:` }],
  };
  const result = await callAnthropic(body);
  if (!result.ok) return { classification: 'ERROR', raw: JSON.stringify(result.raw) };
  const cleaned = result.text.trim().toUpperCase().replace(/[^A-Z]/g, '');
  const valid = ['ROUTE', 'GREETING', 'PRODUCT', 'ACCOUNT'];
  return { classification: valid.includes(cleaned) ? cleaned : 'ERROR', raw: result.text };
}

async function routeQuery(comment: string): Promise<{ handles: string[]; raw: string; error: string | null }> {
  const body = {
    model: ROUTER_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: [
      { type: 'text', text: ROUTER_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: ROUTER_INDEX_BLOCK, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: `Current query: ${comment}` }],
  };
  const result = await callAnthropic(body);
  if (!result.ok) return { handles: [], raw: JSON.stringify(result.raw), error: 'API error' };
  const first = result.text.indexOf('{');
  const last = result.text.lastIndexOf('}');
  const stripped = first !== -1 && last > first ? result.text.slice(first, last + 1) : result.text;
  try {
    const parsed = JSON.parse(stripped) as { handles?: unknown };
    if (!Array.isArray(parsed.handles)) return { handles: [], raw: result.text, error: null };
    const handles = parsed.handles
      .filter((h): h is string => typeof h === 'string' && /^[a-z0-9-]+$/.test(h) && h.length <= 120)
      .filter(h => VALID_HANDLES.has(h))
      .slice(0, 3);
    return { handles, raw: result.text, error: null };
  } catch {
    return { handles: [], raw: result.text, error: 'parse failed' };
  }
}

const MAX_BLOG_CHARS = 80_000;
function loadHandleContent(handle: string): string | null {
  const entry = BLOG_INDEX.find(a => a.handle === handle);
  const dir = entry?.type === 'guideline' ? 'docs/guideline' : entry?.type === 'pathway' ? 'docs/pathway' : 'docs/blog';
  const filepath = path.join(REPO_ROOT, dir, `${handle}.md`);
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return content.replace(/^---[\s\S]*?---\n\n?/, ''); // strip frontmatter
  } catch {
    return null;
  }
}

function loadMatchedContent(handles: string[]): string {
  if (handles.length === 0) return '';
  const parts: string[] = [];
  let totalChars = 0;
  for (const h of handles) {
    const content = loadHandleContent(h);
    if (!content) continue;
    if (totalChars + content.length > MAX_BLOG_CHARS) break;
    parts.push(`### ${h}\n\n${content}`);
    totalChars += content.length;
  }
  return parts.join('\n\n---\n\n');
}

function buildYouTubePlatformContext(blogPost: BlogPost): string {
  return YOUTUBE_PROMPT_TEMPLATE
    .replace('{{VIDEO_TITLE}}', blogPost.title)
    .replace('{{VIDEO_URL}}', `https://youtu.be/${VIDEO_ID}`)
    .replace('{{VIDEO_CONTENT}}', blogPost.body);
}

async function callMainLLM(comment: string, blogPost: BlogPost, matchedHandles: string[]): Promise<{ text: string; error: string | null }> {
  const platformContext = buildYouTubePlatformContext(blogPost);
  const matchedContent = loadMatchedContent(matchedHandles);

  // System block construction mirrors production: cached blocks 1-3 (system prompt
  // + algorithm + products), then per-request platform context + matched content.
  const cachedBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: ALGORITHM_DOC, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: PRODUCTS_DOC, cache_control: { type: 'ephemeral' } },
  ];
  const perRequestBlocks: { type: 'text'; text: string }[] = [
    { type: 'text', text: platformContext },
  ];
  if (matchedContent) {
    perRequestBlocks.push({ type: 'text', text: `## Referenced Blog Articles\n\n${matchedContent}` });
  }

  const body = {
    model: MAIN_LLM_MODEL,
    max_tokens: 800,
    temperature: 0.3,
    system: [...cachedBlocks, ...perRequestBlocks],
    messages: [{ role: 'user', content: comment }],
  };

  const result = await callAnthropic(body);
  if (!result.ok) return { text: '', error: `API error: ${JSON.stringify(result.raw).slice(0, 200)}` };
  return { text: result.text.trim(), error: null };
}

// ---------------------------------------------------------------------------
// Run pipeline per comment with bounded concurrency
// ---------------------------------------------------------------------------

interface DryRunResult {
  comment: YouTubeComment;
  filter: FilterDecision;
  classification?: string;
  routerHandles?: string[];
  routerError?: string | null;
  reply?: string;
  replyError?: string | null;
  willPost: boolean;
  skipReason?: string;
}

async function processOne(c: YouTubeComment, blogPost: BlogPost): Promise<DryRunResult> {
  const filter = filterComment(c);
  if (!filter.keep) {
    return { comment: c, filter, willPost: false, skipReason: `filtered: ${filter.reason}` };
  }

  const cls = await classify(c.text);
  if (cls.classification === 'GREETING') {
    return {
      comment: c, filter, classification: 'GREETING',
      willPost: false, skipReason: 'classifier=GREETING (silent skip)',
    };
  }

  let handles: string[] = [];
  let routerError: string | null = null;
  if (cls.classification === 'ROUTE' || cls.classification === 'ERROR') {
    const r = await routeQuery(c.text);
    handles = r.handles;
    routerError = r.error;
  }

  const main = await callMainLLM(c.text, blogPost, handles);

  let willPost = !!main.text && !main.error;
  let skipReason: string | undefined;
  if (main.text.trim() === 'SKIP_NO_REPLY') {
    willPost = false;
    skipReason = 'main-LLM returned SKIP_NO_REPLY';
  } else if (main.error) {
    willPost = false;
    skipReason = `main-LLM error: ${main.error}`;
  }

  return {
    comment: c, filter,
    classification: cls.classification,
    routerHandles: handles,
    routerError,
    reply: main.text,
    replyError: main.error,
    willPost,
    skipReason,
  };
}

async function runAll(comments: YouTubeComment[], blogPost: BlogPost): Promise<DryRunResult[]> {
  const queue = [...comments];
  const out: DryRunResult[] = [];
  let done = 0;
  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) break;
      const r = await processOne(c, blogPost);
      out.push(r);
      done++;
      process.stdout.write(`\r  ${done}/${comments.length} comments processed`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stdout.write('\n');
  // Preserve original (likes-desc) order
  out.sort((a, b) => comments.indexOf(a.comment) - comments.indexOf(b.comment));
  return out;
}

// ---------------------------------------------------------------------------
// HTML output
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHTML(results: DryRunResult[], blogPost: BlogPost): string {
  const totalComments = results.length;
  const willPost = results.filter(r => r.willPost).length;
  const filtered = results.filter(r => !r.filter.keep).length;
  const greetingSkips = results.filter(r => r.classification === 'GREETING').length;
  const llmSkips = results.filter(r => r.skipReason?.includes('SKIP_NO_REPLY')).length;
  const errors = results.filter(r => r.replyError || r.routerError).length;

  const classifierColor = (c?: string) => {
    if (c === 'ROUTE') return '#2b5fb0';
    if (c === 'GREETING') return '#888';
    if (c === 'PRODUCT') return '#a06030';
    if (c === 'ACCOUNT') return '#a06030';
    if (c === 'ERROR') return '#c0392b';
    return '#888';
  };

  const rowHtml = (r: DryRunResult, idx: number) => {
    const c = r.comment;
    const replyHtml = r.reply
      ? `<div class="reply ${r.willPost ? 'will-post' : 'will-skip'}">${escapeHtml(r.reply)}</div>`
      : '<div class="reply none"><em>(no reply generated)</em></div>';
    const skipBadge = r.willPost
      ? '<span class="badge will-post-badge">WILL POST</span>'
      : `<span class="badge skip-badge">SKIP — ${escapeHtml(r.skipReason ?? 'unknown')}</span>`;
    const classBadge = r.classification
      ? `<span class="badge" style="background:${classifierColor(r.classification)};color:white">${r.classification}</span>`
      : '';
    const handlesHtml = r.routerHandles && r.routerHandles.length > 0
      ? `<div class="handles">router handles: ${r.routerHandles.map(h => `<code>${escapeHtml(h)}</code>`).join(', ')}</div>`
      : '';
    return `
      <li class="comment" data-will-post="${r.willPost ? '1' : '0'}">
        <div class="comment-header">
          <span class="idx">#${idx + 1}</span>
          <span class="author">${escapeHtml(c.author)}</span>
          <span class="meta">${c.likes}♥ · ${c.replyCount} replies · ${c.publishedAt}</span>
          ${classBadge}
          ${skipBadge}
        </div>
        <div class="comment-text">${escapeHtml(c.text)}</div>
        ${handlesHtml}
        ${replyHtml}
      </li>`;
  };

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>YouTube dry-run: ${escapeHtml(blogPost.title)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; margin: 0; padding: 24px; max-width: 1100px; color: #1a1a1a; background: #fafafa; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { font-size: 16px; margin: 32px 0 12px; }
  .subtitle { color: #555; margin-bottom: 16px; }
  .summary { background: #fff; border: 1px solid #ddd; padding: 12px 16px; border-radius: 6px; margin-bottom: 24px; }
  .summary-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px 16px; margin-top: 8px; }
  .summary-grid div { font-size: 13px; }
  .summary-grid strong { display: block; font-size: 18px; }
  .controls { background: #fff; border: 1px solid #ddd; padding: 8px 12px; border-radius: 6px; margin-bottom: 16px; }
  .controls label { margin-right: 16px; font-size: 13px; cursor: pointer; }
  ul.comments { list-style: none; padding: 0; margin: 0; }
  li.comment { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 12px 16px; margin-bottom: 12px; }
  li.comment[data-will-post="0"] { opacity: 0.65; }
  .comment-header { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 6px; }
  .idx { color: #888; font-family: ui-monospace, monospace; font-size: 12px; }
  .author { font-weight: 600; }
  .meta { color: #888; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .will-post-badge { background: #2f7a4d; color: white; }
  .skip-badge { background: #eee; color: #555; font-weight: 400; }
  .comment-text { white-space: pre-wrap; font-size: 14px; color: #333; margin: 4px 0 6px; padding: 6px 10px; background: #f5f5f5; border-radius: 4px; }
  .handles { font-size: 12px; color: #555; margin-bottom: 4px; }
  .handles code { background: #eef4fc; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  .reply { white-space: pre-wrap; padding: 8px 12px; border-radius: 4px; font-size: 14px; line-height: 1.55; margin-top: 6px; }
  .reply.will-post { background: #e9f4ec; border-left: 3px solid #2f7a4d; }
  .reply.will-skip { background: #f8f4eb; border-left: 3px solid #b06a2b; color: #555; }
  .reply.none { background: #f5f5f5; color: #888; }
</style>
</head><body>
<h1>YouTube comment dry-run</h1>
<div class="subtitle">Video: <a href="https://youtu.be/${VIDEO_ID}">${escapeHtml(blogPost.title)}</a> · Blog: <code>${escapeHtml(blogPost.slug)}.md</code> · Model: ${MAIN_LLM_MODEL}</div>

<div class="summary">
  <strong>Summary</strong>
  <div class="summary-grid">
    <div><strong>${totalComments}</strong>total fetched</div>
    <div><strong>${willPost}</strong>would post</div>
    <div><strong>${filtered}</strong>filtered out</div>
    <div><strong>${greetingSkips}</strong>greeting-skips</div>
    <div><strong>${llmSkips}</strong>LLM-skips</div>
    <div><strong>${errors}</strong>errors</div>
  </div>
</div>

<div class="controls">
  <label><input type="checkbox" id="show-skipped" checked> Show skipped</label>
  <label><input type="checkbox" id="show-posted" checked> Show would-post</label>
</div>

<ul class="comments">
${results.map((r, i) => rowHtml(r, i)).join('')}
</ul>

<script>
  const showSkipped = document.getElementById('show-skipped');
  const showPosted = document.getElementById('show-posted');
  function apply() {
    document.querySelectorAll('li.comment').forEach(li => {
      const wp = li.dataset.willPost === '1';
      li.style.display = (wp ? showPosted.checked : showSkipped.checked) ? '' : 'none';
    });
  }
  showSkipped.addEventListener('change', apply);
  showPosted.addEventListener('change', apply);
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const RESET = '\x1b[0m', BOLD = '\x1b[1m', GREY = '\x1b[90m';
  console.log(`${BOLD}=== YouTube comment dry-run ===${RESET}`);
  console.log(`Video ID:     ${VIDEO_ID}`);
  console.log(`Anthropic key: ${usingTestKey ? 'ANTHROPIC_TEST_API_KEY' : 'ANTHROPIC_API_KEY (prod-shared)'}`);

  console.log(`${GREY}Looking up blog post...${RESET}`);
  const blogPost = loadBlogPostForVideo(VIDEO_ID);
  console.log(`  Matched: ${blogPost.slug}.md ("${blogPost.title}")`);

  console.log(`${GREY}Fetching comments (max ${limit})...${RESET}`);
  const allComments = fetchComments(VIDEO_ID, limit);
  const comments = allComments.slice(0, limit);
  console.log(`  Fetched ${allComments.length} top-level comments (using first ${comments.length})`);

  console.log(`${GREY}Running pipeline (concurrency=${concurrency})...${RESET}`);
  const results = await runAll(comments, blogPost);

  const outDir = path.join(REPO_ROOT, 'tools/output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `youtube-dryrun-${VIDEO_ID}.html`);
  fs.writeFileSync(outPath, renderHTML(results, blogPost));

  const willPost = results.filter(r => r.willPost).length;
  console.log(`\n${BOLD}=== Results ===${RESET}`);
  console.log(`  Comments processed: ${results.length}`);
  console.log(`  Would post:         ${willPost}`);
  console.log(`  Would skip:         ${results.length - willPost}`);
  console.log(`\nReport: ${outPath}`);
  console.log(`Open with: open "${outPath}"`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
