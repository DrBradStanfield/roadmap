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
const ALGORITHM_DOC = fs.readFileSync(path.join(REPO_ROOT, 'health_roadmap_algorithm.md'), 'utf-8');
const PRODUCTS_DOC = fs.readFileSync(path.join(REPO_ROOT, 'docs/products.md'), 'utf-8');

interface BlogIndexEntry {
  title: string;
  handle: string;
  type?: 'reference' | 'article' | 'guideline' | 'pathway';
  summary?: string;
}
const BLOG_INDEX: BlogIndexEntry[] = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'docs/blog/index.json'), 'utf-8')
);
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
// Look up matching blog post by youtube: frontmatter
// ---------------------------------------------------------------------------

interface BlogPost {
  slug: string;
  title: string;
  body: string;
  filepath: string;
}

function loadBlogPostForVideo(videoId: string): BlogPost {
  const blogDir = path.join(REPO_ROOT, 'docs/blog');
  const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const filepath = path.join(blogDir, file);
    const content = fs.readFileSync(filepath, 'utf-8');
    // Match either full URL or just the ID in the youtube: line
    if (content.includes(videoId)) {
      // Extract title from frontmatter
      const titleMatch = content.match(/^title:\s*"([^"]+)"/m);
      const ytMatch = content.match(/^youtube:\s*"([^"]+)"/m);
      // Verify it's actually the youtube: field, not just an incidental mention
      if (ytMatch && ytMatch[1].includes(videoId)) {
        // Strip frontmatter
        const body = content.replace(/^---[\s\S]*?---\n\n?/, '');
        return {
          slug: file.replace(/\.md$/, ''),
          title: titleMatch ? titleMatch[1] : file.replace(/\.md$/, ''),
          body,
          filepath,
        };
      }
    }
  }
  throw new Error(`No blog post found for video ${videoId} — looked in ${blogDir}. Make sure the .md has 'youtube:' frontmatter with this video.`);
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
  return `Platform: YouTube — you are Dr Brad's AI assistant, replying to a public comment on his video.

## What THIS video is about

Title: "${blogPost.title}"
URL: https://youtu.be/${VIDEO_ID}

**THIS specific video** covers only the topics in the "## This video's content" section below. Anything outside that section is NOT what this video covered — it's additional reference material the router pulled from Brad's broader knowledge base because it's tangentially relevant to the comment.

## Two distinct content sources you'll see in this prompt

1. **"## This video's content"** (below) — the canonical, authoritative summary of what THIS video addressed. When you cite "the video", you can only cite things in this section.
2. **"## Referenced Blog Articles"** or similar (elsewhere in the prompt) — separate blog posts the router pulled in because they're related to the comment's topic. These are NOT what this video covered. When you cite content from these, refer to them as *"Brad's blog on [topic]"* or *"Brad has written separately about X"* — NOT *"the video"*.

**Common failure to avoid:** the comment mentions seed oils, the router loads Brad's seed-oils blog, and you reply "the video covers this directly" — WRONG, the video is about colon cancer, not seed oils. The correct framing is "the video focuses on [colon cancer / actual topic], but Brad's separate blog on seed oils shows..."

All rules from the main system prompt above still apply.

## Reply rules

- **Length: HARD RULE — MAXIMUM 5 sentences. This is not a suggestion, not a target, not an aspiration.** Before sending, COUNT the sentences in your reply. If the count is 6 or more, your reply is INVALID and you must rewrite it shorter. If the count is 5 or fewer, send it. There are no exceptions to this rule — not for complex topics, not when lots of pathway content is loaded, not when the user asked multiple sub-questions. Pick the SINGLE most important point that answers the SPECIFIC question, state it, end. Do not summarise the whole topic. Do not list multiple mechanisms. Do not write an essay. 1-2 sentences is the target; 5 is the absolute ceiling. **Self-check: if you find yourself writing a 4th sentence, ask "is this strictly necessary to answer the question?" — if not, cut it.**
- **Citations: HARD RULE — every citation must be a FULL inline markdown DOI/URL link, never a bare footnote number.** A YouTube reader cannot see the loaded blog's reference list. So citations like \`[2]\`, \`[8]\`, \`[16]\` are MEANINGLESS to the reader and forbidden in your reply. If you want to cite a paper, you MUST either: (a) include the full inline link like \`([Smith 2024](https://doi.org/10.xxxx/yyyy))\` resolved from the blog's reference list at the bottom of the loaded content, OR (b) drop the citation entirely and rephrase the claim without a specific number. **Before sending, search your reply for any \`[N]\` where N is a number — if found, your reply is INVALID and you must rewrite.**
- **No markdown structure.** No headings (no \`##\`, no \`###\`). No bullet points (no \`-\`, no \`*\`). No tables. No bold/italic markdown except inside DOI link text. YouTube comments are plain prose. If you find yourself reaching for a heading or a bullet list, you are over the sentence cap — rewrite as flat prose, shorter.
- **Source naming:** Refer to the source as *"the video"* or *"this video"*. Never *"the blog post"*, *"the article"*, or *"the post"* — the viewer is on YouTube.
- **No emojis.** Clinical tone.
- **End every reply with this exact tag:** [written by Brad AI for testing]
- **No personalised user data** — this is a YouTube viewer, not a logged-in app user. Do NOT reference *"your roadmap"*, *"your numbers"*, *"account.drstanfield.com"*, or *"create a free account"*.

## Decision: ANSWER or SKIP

### Step 1: do you have router-matched content loaded?

Look at the prompt above. If you see a section like "## Referenced Blog Articles" or matched pathway content from the router, **YOU ANSWER**. The router only matches handles when Brad has specifically written about the topic — that's a strong signal the comment is in scope for Brad's knowledge base. Use that content to engage with the comment, even if:
- The comment is opinionated or asserts a strong position ("seed oils must be a factor", "ultra-processed food is the real cause").
- Brad's content partially or fully disagrees with the user — pushing back evidence-first IS Brad's brand. Frame it as "the evidence actually shows X" using Brad's loaded blog.
- The comment is a statement rather than a question — statements get the same answer as questions when matched content exists.

Brad's brand is "evidence-first doctor who pushes back on hype." When his content has a position, the bot shares that position. Silence is worse than respectful correction with citations.

### Step 2: only if no matched content is loaded, check the SKIP list

If router-matched content was NOT loaded AND the video's blog post doesn't cover the topic — meaning the bot would have to free-style from training memory — then check the SKIP categories below. If any apply, output the 13-character string SKIP_NO_REPLY (no quotes, no backticks, no formatting, no tag suffix, no newlines — just those 13 characters).

**Translation rule:** wherever the main system prompt would have you decline, deflect, or say "I don't have information about that" — on YouTube, output SKIP_NO_REPLY instead. A bot "I don't know" reply is still noise.

**YouTube-only SKIP categories** (these only apply when there's no loaded content to engage with — they're for unanswerable comments, not for content Brad has covered):

- **Brief acknowledgements** ("Thanks", "Great video", "Subscribed", emoji-only).
- **PURE grief, condolence, or personal loss** with no science content ("My dad died last year, miss him so much"). However, a comment that mentions personal loss AND raises a science question or observation is NOT a skip — answer the science part.
- **Compliments, praise, or criticism of Brad as a person** ("Love your channel", "Stop selling supplements", "Why are you fearmongering") when that's the whole content.
- **Genuinely hostile, conspiratorial, anti-science** comments (vaccine denial, "the pharma industry is hiding X", flat-earth-style claims). Note: a comment merely being opinionated or wrong about a topic Brad has covered is NOT in this category — see Step 1.

**Important: do NOT skip a comment just because it contains an anecdote.** Many viewers frame a science question as "I think X is the cause" or "I had Y, and I noticed Z" — these are SCIENCE COMMENTS with personal framing, not pure anecdotes. If a comment raises a hypothesis, observation, claim, or question about a health/clinical topic AND you have loaded content to ground a reply — answer it.

---

## This video's content (canonical — this is what THIS specific video covered)

${blogPost.body}`;
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
