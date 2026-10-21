/**
 * search_knowledge and get_article on the hosted connector (US-41 AC6–AC12).
 *
 * The chatbot's knowledge base, offered to the user's own assistant. The
 * user's AI pays: nothing here calls a model, an embeddings API or any other
 * network service. It is the CLI's BM25 ranker (`tools/search-knowledge.ts`)
 * over the files bundled into the image (`docs/blog/index.json` and the
 * bodies under docs/blog), and the client's
 * model reads what comes back.
 *
 * Off unless `MCP_KNOWLEDGE_TOOLS=on`: while off, `tools/list`, `initialize`
 * and every tool call answer exactly as they did before this file existed.
 *
 * The query and the handle are read and dropped: no log, no counter, and no
 * refusal repeats them.
 */
import { z } from 'zod';
import { bestSection, buildIndex, search, tokenize, type Index } from '../../tools/search-knowledge';
import { isMaster, loadBlogIndex, type BlogIndexEntry } from './blog-index.server';
import { loadBlogArticle } from './matched-content';
import { parseFrontmatter, stripFrontmatter } from './frontmatter';
import { routerView } from './router-view';
import type { McpToolDefinition, ToolAnswer } from '../../packages/health-core/src/mcp-tools';

/** The switch. Only the exact word `on` turns the tools on; unset, empty or anything else is off. */
export function knowledgeToolsEnabled(): boolean {
  return process.env.MCP_KNOWLEDGE_TOOLS === 'on';
}

/** Results per search: enough to answer, too few to page through the library. */
export const MAX_RESULTS = 5;
/** The BM25 pool the masters are promoted from, wider than what is returned. */
const POOL = 20;
/** Characters of body text per search result. */
export const MAX_EXCERPT_CHARS = 1_500;
/**
 * Characters of a master's excerpt, its whole Current view (US-50 AC13). The
 * writer contract puts "who should not take it" last in the view, and views run
 * 1,233 to 2,449 characters, so a 1,500 cut lost that caution in most. 4,000
 * holds every view with room (a test checks each served view fits), and stays
 * under youtube-context's MAX_VIEW_CHARS (6,000), past which a view is malformed.
 */
export const MAX_MASTER_EXCERPT_CHARS = 4_000;
/** Characters of one article or section; the longest masters run past 100,000. */
export const MAX_ARTICLE_CHARS = 30_000;
const MAX_QUERY_LENGTH = 200;
const MAX_HANDLE_LENGTH = 120;
const MAX_SECTION_LENGTH = 120;

/**
 * On every result, as its first field. The chatbot's closing line and its
 * scope boundaries (chat-system-prompt.md), which other assistants never see.
 */
export const NOTICE =
  'Educational information from Dr Brad Stanfield\'s library, not personalised medical advice. Always discuss changes ' +
  'with your healthcare provider. Medication doses, new prescriptions and drug interactions are questions for the ' +
  'user\'s doctor or pharmacist. If this could be an emergency, such as chest pain, stroke signs or trouble ' +
  'breathing, call your local emergency number now.';

/** The chatbot's safety rules that matter once the text leaves it, carried in both descriptions. */
const RULES =
  ' How to use it: this is general education, not personalised medical advice. Do not diagnose. Send medication ' +
  'dose changes, new prescriptions and drug interaction questions to the user\'s doctor or pharmacist. If the user ' +
  'describes chest pain, stroke signs or another emergency, tell them to call their emergency number now. Report ' +
  'research as the named study\'s findings and keep the hedged wording ("may", "evidence suggests"). In a topic ' +
  'page, only the Current view section is Dr Brad\'s own view; a video article dated after the page\'s reviewed ' +
  'date may record a newer view. Never present a Dr Brad product as treating or preventing a disease. Cite the ' +
  'link of any entry you use.';

/**
 * Handle words that name no master's topic: the ones every master shares
 * (benefits-forms-dosing-and-side-effects), and generic words a query uses
 * about other things ("olive oil", "cholesterol target", "beetroot extract").
 */
const SHARED_HANDLE_WORDS = new Set(tokenize(
  'benefits forms dosing side effects best types evidence vitamins supplements ' +
  'oil fish acid extract root seed leaf powders lowering boosters cholesterol oxide',
));

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    handle: { type: 'string' },
    type: { type: 'string', enum: ['reference', 'article'] },
    master: { type: 'boolean', description: 'A topic page carrying Dr Brad\'s current view.' },
    title: { type: 'string' },
    url: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'A topic page\'s reviewed date, otherwise the published date.' },
  },
} as const;

export const KNOWLEDGE_TOOLS: McpToolDefinition[] = [
  {
    name: 'search_knowledge',
    cost: 'none',
    _meta: {
      'openai/toolInvocation/invoking': 'Searching Dr Brad\'s library…',
      'openai/toolInvocation/invoked': 'Searched Dr Brad\'s library',
    },
    title: 'Search Dr Brad\'s education library',
    description:
      'Search Dr Brad Stanfield\'s education library: his topic pages on supplements, each with his current view, ' +
      'and his video articles. Returns at most ' +
      `${MAX_RESULTS} entries, topic pages first when the query names their topic, each with a short excerpt, its ` +
      'handle and a public link; read one in full with get_article. This is a word search over files on this ' +
      'server and no model runs here, so query with topic words ("magnesium sleep"), never the user\'s values or ' +
      'personal details. It reads nothing from the health record.' + RULES,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH, description: 'Topic words, e.g. "omega-3 atrial fibrillation".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        notice: { type: 'string' },
        results: {
          type: 'array',
          maxItems: MAX_RESULTS,
          items: { ...RESULT_SCHEMA, properties: { ...RESULT_SCHEMA.properties, summary: { type: 'string' }, excerpt: { type: 'string' } } },
        },
      },
      required: ['notice', 'results'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_article',
    cost: 'none',
    _meta: {
      'openai/toolInvocation/invoking': 'Reading Dr Brad\'s article…',
      'openai/toolInvocation/invoked': 'Read Dr Brad\'s article',
    },
    title: 'Read one entry from Dr Brad\'s library',
    description:
      'Read one entry of Dr Brad Stanfield\'s education library by the handle search_knowledge returned. An entry ' +
      `longer than ${MAX_ARTICLE_CHARS.toLocaleString('en-US')} characters is cut there; \`sections\` lists its headings, ` +
      'and `section` (words from one heading, e.g. "Safety" or "Drug Interactions") reads that section instead. A cut ' +
      'entry carries its safety, side-effect, interaction and caution sections after the cut, and its note says if any were cut or none were found. ' +
      'Before answering about a dose, side effects or interactions, read the entry\'s safety and interactions ' +
      'sections. No model runs here, and it reads nothing from the health record.' + RULES,
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: MAX_HANDLE_LENGTH, description: 'The handle search_knowledge returned.' },
        section: { type: 'string', minLength: 1, maxLength: MAX_SECTION_LENGTH, description: 'Words from one of the entry\'s section headings.' },
      },
      required: ['handle'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        notice: { type: 'string' },
        ...RESULT_SCHEMA.properties,
        section: { type: ['string', 'null'], description: 'The heading read, or null for the whole entry.' },
        sections: { type: 'array', items: { type: 'string' } },
        body: { type: 'string' },
        truncated: { type: 'boolean' },
      },
      required: ['notice', 'handle', 'title', 'body', 'truncated', 'sections'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Appended to the connector's instructions only while the switch is on. */
export const KNOWLEDGE_NOTE =
  ' search_knowledge and get_article read Dr Brad\'s education library, not the record; what they return is ' +
  'education, not medical advice, and each result says so.';

const searchInput = z.object({ query: z.string().trim().min(1).max(MAX_QUERY_LENGTH) }).strict();
const articleInput = z.object({
  handle: z.string().max(MAX_HANDLE_LENGTH).regex(/^[a-z0-9-]+$/),
  section: z.string().trim().min(1).max(MAX_SECTION_LENGTH).optional(),
}).strict();

export function isKnowledgeTool(name: string): boolean {
  return KNOWLEDGE_TOOLS.some((tool) => tool.name === name);
}

/**
 * What is already public under Brad's name (AC11): his video articles and the
 * topic masters, each published at its drstanfield.com url. Pathways
 * (HealthPathways-derived), the guidelines (which quote HealthPathways and
 * UpToDate) and the other references (ConsumerLab-derived) stay with the
 * chatbot and are never served here.
 */
export const isServed = (entry: BlogIndexEntry) => (entry.type ?? 'article') === 'article' || isMaster(entry);

/** `url` is the file's own frontmatter link, as the chatbot cites it; never the index's synthesised one. */
function describeEntry(entry: BlogIndexEntry, raw: string) {
  const master = isMaster(entry);
  const url = parseFrontmatter(raw)?.url;
  return {
    handle: entry.handle,
    type: entry.type ?? 'article',
    master,
    title: entry.title,
    url: typeof url === 'string' && url ? url : null,
    date: master ? entry.reviewed! : entry.publishedAt?.slice(0, 10) || null,
  };
}

/** The served part of the index the chatbot's router sees (posts a current master covers are left out), built once. */
let built: { index: Index; byHandle: Map<string, BlogIndexEntry> } | null = null;
function library() {
  if (!built) {
    const view = routerView(loadBlogIndex()).filter(isServed);
    built = { index: buildIndex(view), byHandle: new Map(view.map((e) => [e.handle, e])) };
  }
  return built;
}

/** The body as the model should read it: frontmatter off. */
const bodyOf = (raw: string) => stripFrontmatter(raw).trim();

/** A heading naming a risk (safety, side effects, toxicity, interactions, who should take care), at any level from `##`. */
const SAFETY_HEADING = /^(#{2,6}) .*\b(?:safety|side effects?|toxicity|interactions?|contraindications?|precautions?|adverse|cautions?|warnings?|pregnancy|special populations?|risk factors?)\b.*$/gim;
/** The body start a cut always keeps, whatever the safety blocks need: a master's Current view and Key safety points. */
const MIN_START_CHARS = 4_000;

/**
 * Every safety block of a body: a matching heading to the next heading of its
 * level or higher. A block inside one already taken is not taken again.
 */
export function safetyBlocks(body: string): string[] {
  const blocks: string[] = [];
  let taken = -1;
  for (const m of body.matchAll(SAFETY_HEADING)) {
    if (m.index! < taken) continue;
    const rest = body.slice(m.index! + m[0].length);
    const next = rest.search(new RegExp(`^#{2,${m[1].length}} `, 'm'));
    taken = m.index! + m[0].length + (next === -1 ? rest.length : next);
    blocks.push(body.slice(m.index!, taken).trim());
  }
  return blocks;
}

/**
 * A whole entry over the cap: its start, a note, then its safety blocks. The
 * room for the blocks is reserved first, so the total stays inside the cap.
 * The note says what follows: the blocks whole, the blocks cut (when they
 * alone pass the room left after MIN_START_CHARS), or that there are none,
 * naming the headings the cut dropped.
 */
export function cutEntry(body: string, cap = MAX_ARTICLE_CHARS): string {
  const head = `\n\n[Cut at the ${cap.toLocaleString('en-US')}-character limit (the entry has ${body.length.toLocaleString('en-US')}). `;
  let blocks = safetyBlocks(body).join('\n\n');
  if (!blocks) {
    const room = cap - head.length - 300;
    const dropped = sectionsOf(body.slice(room)).map(headingOf).join(' | ');
    const note = `${head}No safety section was found in this entry; read the sections list. Cut-off sections: ${dropped}`.slice(0, cap - room - 2) + ']';
    return `${body.slice(0, room)}${note}`;
  }
  const whole = 'Its safety, side-effect, toxicity, interaction and caution sections follow whole; read any other part with section.]\n\n';
  const over = 'Its safety, side-effect, toxicity, interaction and caution sections are too long to fit whole: they follow, cut at the limit. Read each with section.]\n\n';
  const fits = head.length + whole.length + blocks.length <= cap - MIN_START_CHARS;
  const note = head + (fits ? whole : over);
  if (!fits) blocks = blocks.slice(0, cap - MIN_START_CHARS - note.length);
  return `${body.slice(0, cap - note.length - blocks.length)}${note}${blocks}`;
}

/** The `## ` sections of a body, each from its heading to the next. */
const sectionsOf = (body: string) => body.split(/^(?=## )/m).filter((s) => s.startsWith('## '));
const headingOf = (section: string) => section.slice(3, section.indexOf('\n') === -1 ? undefined : section.indexOf('\n')).trim();

/**
 * Masters first: a master in the BM25 pool goes ahead of everything else when
 * the query names its topic, a query word that is one of its handle's own
 * words ("magnesium", "omega", "vitaminc"), not one every master shares.
 */
function searchKnowledge(query: string): ToolAnswer {
  const { index, byHandle } = library();
  const terms = new Set(tokenize(query));
  const pool = search(index, query, POOL, POOL);
  const names = (handle: string) => tokenize(handle.replace(/-/g, ' ')).some((w) => !SHARED_HANDLE_WORDS.has(w) && terms.has(w));
  const first = pool.filter((hit) => isMaster(byHandle.get(hit.handle)!) && names(hit.handle));
  const ranked = [...first, ...pool.filter((hit) => !first.includes(hit))].slice(0, MAX_RESULTS);
  const results = ranked.map((hit) => {
    const entry = byHandle.get(hit.handle)!;
    const raw = loadBlogArticle(hit.handle) ?? '';
    const body = bodyOf(raw);
    // A master's excerpt is its Current view (the chatbot's precedence rule); any other entry's, its best-matching section.
    const view = isMaster(entry) ? sectionsOf(body).find((s) => /^## Current (view|evidence position)\b/.test(s)) : undefined;
    const excerpt = view ? view.trim().slice(0, MAX_MASTER_EXCERPT_CHARS) : bestSection(body, query, MAX_EXCERPT_CHARS).trim().slice(0, MAX_EXCERPT_CHARS);
    return { ...describeEntry(entry, raw), summary: entry.summary ?? '', excerpt };
  });
  return answer({ notice: NOTICE, results });
}

function getArticle(handle: string, wanted: string | undefined): ToolAnswer {
  const entry = loadBlogIndex().find((e) => e.handle === handle);
  const raw = entry && isServed(entry) ? loadBlogArticle(handle) : null;
  if (!entry || raw === null) {
    return { text: `${NOTICE}\n\nNo entry has that handle. Use a handle search_knowledge returned.`, isError: true, reason: 'not-found' };
  }
  const body = bodyOf(raw);
  const sections = sectionsOf(body);
  const headings = sections.map(headingOf);
  let text = body;
  let section: string | null = null;
  if (wanted !== undefined) {
    const words = tokenize(wanted);
    const i = words.length === 0 ? -1 : headings.findIndex((h) => { const hw = new Set(tokenize(h)); return words.every((w) => hw.has(w)); });
    if (i === -1) {
      return { text: `${NOTICE}\n\nThat entry has no section whose heading holds those words. Its sections: ${headings.join(' | ')}`, isError: true, reason: 'not-found' };
    }
    [text, section] = [sections[i].trim(), headings[i]];
  }
  const truncated = text.length > MAX_ARTICLE_CHARS;
  // A whole entry keeps its safety blocks; one section is cut plainly, since the
  // section list names the safety sections to read next.
  const cut = !truncated ? text : section === null ? cutEntry(text)
    : `${text.slice(0, MAX_ARTICLE_CHARS - 120)}\n\n[Cut at the ${MAX_ARTICLE_CHARS.toLocaleString('en-US')}-character limit; this section has ${text.length.toLocaleString('en-US')}.]`;
  return answer({ notice: NOTICE, ...describeEntry(entry, raw), section, sections: headings, body: cut, truncated });
}

/** An OK answer: the text is the structured answer serialised, as on every other tool, so the notice leads both. */
function answer(structured: Record<string, unknown>): ToolAnswer {
  return { text: JSON.stringify(structured), isError: false, structured };
}

/** One knowledge tool call. Synchronous, and nothing in it reaches the network. */
export function callKnowledgeTool(name: string, args: unknown): ToolAnswer {
  if (name === 'search_knowledge') {
    const parsed = searchInput.safeParse(args ?? {});
    if (!parsed.success) return malformed(`search_knowledge needs query: 1 to ${MAX_QUERY_LENGTH} characters of topic words, and nothing else.`);
    return searchKnowledge(parsed.data.query);
  }
  const parsed = articleInput.safeParse(args ?? {});
  if (!parsed.success) {
    return malformed(`get_article needs handle (lower-case letters, digits and hyphens, as search_knowledge returned it) and, optionally, section (1 to ${MAX_SECTION_LENGTH} characters).`);
  }
  return getArticle(parsed.data.handle, parsed.data.section);
}

/** A refusal in fixed words: never the query or handle the caller sent. */
function malformed(text: string): ToolAnswer {
  return { text: `${NOTICE}\n\n${text}`, isError: true, reason: 'malformed' };
}
