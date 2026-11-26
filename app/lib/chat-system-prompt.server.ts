/**
 * The chat docs: one load state per process (US-15 AC65, AC72, AC80). Nothing
 * is read at import. The first chatDocs() call (app/entry.server.tsx, at server
 * start) reads every file once and sends one 'read' event; `transition` is the
 * only way the state changes.
 *
 * - 'missing': a required file (CHAT_DOC_FILES) is absent, unreadable or blank.
 *   It names the files and carries no text, so no caller can build a prompt
 *   without narrowing first. The web and iPhone chat answer 503, the Discord
 *   and YouTube bots do not start, and the prompt builders throw: no model call.
 * - 'degraded': the required files are there, an optional one (OPTIONAL_DOC_FILES,
 *   the blog index) is not. Chat answers without it, as it always has.
 * - 'loaded': every file is there.
 *
 * The first read reports once: one Sentry error for 'missing', one per absent
 * file for 'degraded'. File names only, never file text. /healthz ignores it.
 */
import * as Sentry from '@sentry/react-router';
import fs from 'fs';
import path from 'path';
import { SUGGESTION_EVIDENCE } from '../../packages/health-core/src/evidence';
import { BLOG_INDEX_FILE, loadBlogIndex, readBlogIndex, type BlogIndexEntry } from './blog-index.server';
import { PRODUCTS_BLOCK_FILES, productsBlockText } from './chat-products-block';
import { routerIndexBlock, routerView } from './router-view';

/** Chat answers from these. Absent, unreadable or blank after trim turns chat off. */
const CHAT_DOC_FILES = {
  text: 'app/lib/chat-system-prompt.md',
  algorithm: 'health_roadmap_algorithm.md',
  products: PRODUCTS_BLOCK_FILES.products,
  doctorPosture: 'app/lib/chat-posture-doctor.md',
  brandPosture: 'app/lib/chat-posture-brand.md',
} as const;

/** Chat answers without these, as before, once reported. */
const OPTIONAL_DOC_FILES = {
  writingStyle: PRODUCTS_BLOCK_FILES.writingStyle,
  answerBank: PRODUCTS_BLOCK_FILES.answerBank,
  routerPrompt: 'app/lib/chat-router-prompt.md',
  classifierPrompt: 'app/lib/chat-classifier-prompt.md',
} as const;

/** What the prompt builders and the router read, assembled once at load. */
export interface ChatDocs {
  /** The system prompt, then the algorithm. */
  systemPrompt: string;
  evidence: string;
  /** Products, writing style, answer bank: one cached block on every surface (US-15 AC29). */
  productsBlock: string;
  knowledgeOverview: string;
  doctorPosture: string;
  brandPosture: string;
  /** The router's view of the index (US-50 AC3): prompt with {{ENTRY_COUNT}} filled, index block, allow-list. */
  router: { prompt: string; indexBlock: string; handles: ReadonlySet<string> };
  /** The pre-router classifier's system text, whole (US-15 AC81); '' fails it open. */
  classifierPrompt: string;
}

export type ChatDocsState =
  | { kind: 'unread' }
  | { kind: 'loaded'; docs: ChatDocs }
  | { kind: 'degraded'; docs: ChatDocs; absent: string[] }
  | { kind: 'missing'; files: string[] };

export type ReadChatDocs = Exclude<ChatDocsState, { kind: 'unread' }>;

/** One read of every file: its text, or null when absent or unreadable. */
export type ChatDocsEvent = { type: 'read'; texts: Record<string, string | null>; blogIndex: BlogIndexEntry[] };

export function transition(state: ChatDocsState, event: ChatDocsEvent): ChatDocsState {
  if (state.kind !== 'unread') return state; // read once per process
  const text = (file: string) => (event.texts[file]?.trim() ? event.texts[file]! : '');
  const files = Object.values(CHAT_DOC_FILES).filter((f) => !text(f));
  if (files.length) return { kind: 'missing', files };
  const absent = [...Object.values(OPTIONAL_DOC_FILES).filter((f) => !text(f)), ...(event.blogIndex.length ? [] : [BLOG_INDEX_FILE])];
  const view = routerView(event.blogIndex);
  const docs: ChatDocs = {
    systemPrompt: text(CHAT_DOC_FILES.text) + text(CHAT_DOC_FILES.algorithm),
    evidence: serializeEvidence(),
    productsBlock: productsBlockText({
      products: text(CHAT_DOC_FILES.products),
      writingStyle: text(OPTIONAL_DOC_FILES.writingStyle),
      answerBank: text(OPTIONAL_DOC_FILES.answerBank),
    }),
    knowledgeOverview: knowledgeOverview(event.blogIndex),
    doctorPosture: text(CHAT_DOC_FILES.doctorPosture),
    brandPosture: text(CHAT_DOC_FILES.brandPosture),
    router: {
      // {{ENTRY_COUNT}} comes from the view, so the prompt cannot drift from the list it is handed
      // (a hard-coded 991 stood in the file until 2026-08-07, when the index held 1,015).
      prompt: text(OPTIONAL_DOC_FILES.routerPrompt).replace(/\{\{ENTRY_COUNT\}\}/g, String(view.length)),
      indexBlock: routerIndexBlock(view),
      handles: new Set(view.map((e) => e.handle)),
    },
    classifierPrompt: text(OPTIONAL_DOC_FILES.classifierPrompt),
  };
  return absent.length ? { kind: 'degraded', docs, absent } : { kind: 'loaded', docs };
}

const TAGS = { feature: 'chat', subsystem: 'system-prompt' };

function report(state: ChatDocsState): void {
  if (state.kind === 'missing') {
    const files = state.files.join(', ');
    console.error(`CHAT DOCS MISSING: ${files} missing or empty; chat is off`);
    Sentry.captureMessage(`Chat docs missing: ${files}`, { level: 'error', tags: TAGS });
  }
  if (state.kind === 'degraded') {
    for (const file of state.absent) {
      console.error(`CHAT KNOWLEDGE MISSING: ${file} missing or empty; the chatbot answers without it`);
      Sentry.captureMessage(`Chat knowledge file missing: ${file}`, { level: 'error', tags: TAGS });
    }
  }
}

/**
 * The chat docs of a checkout at `root`, read at the first call, then kept.
 * Tests build their own from a temp folder; the server's is `chatDocs`.
 */
export function createChatDocs(root: string, blogIndex: () => BlogIndexEntry[] = () => readBlogIndex(root)): () => ReadChatDocs {
  let state: ChatDocsState = { kind: 'unread' };
  return () => {
    if (state.kind === 'unread') {
      const read = (file: string) => {
        try { return fs.readFileSync(path.join(root, file), 'utf-8'); } catch { return null; }
      };
      const files = [...Object.values(CHAT_DOC_FILES), ...Object.values(OPTIONAL_DOC_FILES)];
      state = transition(state, { type: 'read', texts: Object.fromEntries(files.map((f) => [f, read(f)])), blogIndex: blogIndex() });
      report(state);
    }
    return state as ReadChatDocs;
  };
}

/** The server's chat docs, from the working directory; the index is the one loadBlogIndex shares. */
export const chatDocs = createChatDocs(process.cwd(), loadBlogIndex);

/**
 * The docs, for code past an entry's AC65 guard. Throws for a caller that
 * skipped it, naming the files only (US-15 AC74), so it builds no prompt.
 */
export function requireChatDocs(): ChatDocs {
  const state = chatDocs();
  if (state.kind === 'missing') throw new Error(`Chat docs missing (${state.files.join(', ')}); no model call`);
  return state.docs;
}

function knowledgeOverview(index: BlogIndexEntry[]): string {
  if (index.length === 0) return '';
  const blogCount = index.filter(a => !a.type || a.type === 'article').length;
  const refCount = index.filter(a => a.type === 'reference').length;
  const guidelines = index.filter(a => a.type === 'guideline');

  const guidelineLines = guidelines.map(g => {
    let line = `- ${g.title}`;
    if (g.summary) {
      const words = g.summary.split(/\s+/);
      line += ` — ${words.length > 50 ? words.slice(0, 50).join(' ') + '...' : g.summary}`;
    }
    return line;
  }).join('\n');

  return `## Knowledge Base

You have access to a health knowledge base with ${index.length} entries. When the user asks about a topic, a retrieval step loads relevant content if available. You do not need to search or request content — if it's relevant, it will appear below.

### Blog & Reference Articles (${blogCount + refCount})
${blogCount} video-based articles and ${refCount} supplement reference articles covering: supplements, skin health, bone health, sleep, longevity, diet, exercise, blood pressure, cholesterol, and blood test interpretation.

### Clinical Guidelines
${guidelineLines}

If matched content appears below, use it to inform your answer. If no content is loaded for a topic, answer from the algorithm, evidence, and product knowledge above.`;
}

/** evidence.ts as the model reads it. */
function serializeEvidence(): string {
  const lines: string[] = ['# Clinical Evidence Reference\n'];
  for (const [id, ev] of Object.entries(SUGGESTION_EVIDENCE)) {
    lines.push(`## ${id}`);
    lines.push(`Reason: ${ev.reason}`);
    if (ev.guidelines.length > 0) {
      lines.push(`Guidelines: ${ev.guidelines.join(', ')}`);
    }
    for (const ref of ev.references) {
      lines.push(`- ${ref.label} (${ref.url})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
