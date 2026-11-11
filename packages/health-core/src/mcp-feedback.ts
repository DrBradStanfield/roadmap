/**
 * `report_feedback`: the privacy guard, the issue it prepares, and the filing.
 * Split out of `mcp-tools.ts`, which re-exports it (issue #429).
 */
import { dayOf } from './merge';
import { foldLpa, LAB_CATALOG, metricNameWords } from './lab-catalog';
import { MAX_NAME_LENGTH } from './lab-extraction';
import { oneLine, printable, REPO_PUBLIC } from './plan';
import { UNIT_DEFS } from './units';
import { type McpRefusalReason } from './product-events';
import { EMAIL_SOURCE, EXTRA_METRIC_NAMES } from './sentry-scrub';
import * as z from './zod';
import {
  FEEDBACK_REPO,
  MAX_FEEDBACK_URL_LENGTH,
  reportFeedbackInput,
  SERVER_VERSION,
  TOOL_LAYER_VERSION,
  type ToolOutcome,
} from './mcp-tool-contract';

/**
 * Unit tokens a number can be wearing, longest first so "mmol/mol" is not
 * matched as "mmol/". Read off the unit definitions rather than written out
 * again, so a new metric's unit joins the guard for free. `in` is dropped: it
 * is an English preposition long before it is inches, and "3 in a row" in a bug
 * report is not a health value.
 */
const UNIT_TOKENS = [...new Set(
  Object.values(UNIT_DEFS).flatMap((def) => [def.canonical, def.label.si, def.label.conventional]),
)].filter((unit) => unit !== 'in').sort((a, b) => b.length - a.length);

/** A number wearing one of those units — "2.1 mmol/L", "81 kg", "140 mmHg". It starts at the head of a digit run,
 *  where the first match always starts anyway: same matches, linear on a long run (US-32 AC58). */
const VALUE_WITH_UNIT = new RegExp(
  `(?<!\\d)\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_TOKENS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9])`,
  'i',
);

/** Words as the guard reads them; a number keeps its decimal ("3.2", "hba1c"). */
const FEEDBACK_WORD = /[a-z0-9]+(?:[.,]\d+)?/g;

/** The Sentry scrub's names that no metric or catalogue name spells, as the guard splits each one. */
const EXTRA_NAMES = EXTRA_METRIC_NAMES.map((name) => foldLpa(name).match(FEEDBACK_WORD) ?? []);

/**
 * Every word a metric or catalogued test is known by; 2 over-refuses on purpose.
 * The one-word names the Sentry scrub adds join them, so "vit" (typed for
 * vitamin, US-73 AC8), "a1c", "bmi" and "height" are names here too (US-32 AC9a).
 */
const METRIC_WORDS = new Set([...metricNameWords(2), ...EXTRA_NAMES.filter((name) => name.length === 1).flat()]);
/** A number typed straight after a word ("ldl140", "a1c7.2"); the word ends in a letter. */
const GLUED_NUMBER = /^([a-z][a-z0-9]*[a-z])(\d+(?:[.,]\d+)?)$/;

/**
 * The words of `text`, with a number glued after a name split off as its value
 * ("ldl140" is "ldl 140", US-32 AC9a). A name that ends in digits stays whole
 * ("igf1", "b12"), and so does a word that is no name ("tab2").
 */
function feedbackWords(text: string): string[] {
  return (foldLpa(text).match(FEEDBACK_WORD) ?? []).flatMap((word) => {
    const glued = GLUED_NUMBER.exec(word);
    return glued && !METRIC_WORDS.has(word) && METRIC_WORDS.has(glued[1]) ? [glued[1], glued[2]] : [word];
  });
}
/** A number and nothing else — what a metric name next to it turns into a value. */
const BARE_NUMBER = /^\d+(?:[.,]\d+)?$/;
/** How many words from a metric name a number still reads as that metric's value. */
const METRIC_DISTANCE = 3;

/**
 * Every catalogue name of two or more words, as the guard splits it. A phrase
 * is one name, so the distance runs from its ends: in "insulin-like growth
 * factor 1 was 200" the generic words inside it cannot carry the value out of
 * reach of "insulin", and the 1 inside it is the name, not a value.
 */
const METRIC_PHRASES = [...new Set(LAB_CATALOG.flatMap((entry) => [entry.label, ...entry.aliases]).map(foldLpa))]
  .map((name) => name.match(FEEDBACK_WORD) ?? [])
  .concat(EXTRA_NAMES)
  .filter((phrase) => phrase.length > 1);

/** "My LDL is 3.2" — a bare number a few words from a name this record knows. */
function valueNearMetric(text: string): string | null {
  const words = feedbackWords(text);
  // Where a name sits: one word, or a whole phrase from its first word to its last.
  const names: Array<[number, number]> = [];
  for (const [i, word] of words.entries()) {
    if (METRIC_WORDS.has(word)) names.push([i, i]);
    for (const phrase of METRIC_PHRASES) {
      if (phrase.every((w, k) => words[i + k] === w)) names.push([i, i + phrase.length - 1]);
    }
  }
  // A name inside a longer one is that longer name: "igf" in "IGF-1" goes, so
  // the 1 is never read as a value.
  const longest = names.filter(([first, last]) =>
    !names.some(([f, l]) => f <= first && l >= last && l - f > last - first));
  for (const [i, word] of words.entries()) {
    if (!BARE_NUMBER.test(word)) continue;
    for (const [first, last] of longest) {
      const inside = i >= first && i <= last;
      if (!inside && i >= first - METRIC_DISTANCE && i <= last + METRIC_DISTANCE) return `${words.slice(first, last + 1).join(' ')} ${word}`;
    }
  }
  return null;
}

/** An email address, as the Sentry scrubber finds one. No `g` flag, so `.test` keeps no state (US-32 AC58). */
const EMAIL = new RegExp(EMAIL_SOURCE);
/** A link carrying a query string — the shape that carries a token or an id. The `?` comes within 2,048
 *  characters of the scheme, as in any real link; the bound keeps it linear on a long run (US-32 AC58). */
const URL_WITH_QUERY = /https?:\/\/\S{0,2048}\?\S/i;
/**
 * A file name, which is a person as often as a document is: lab portals name
 * their downloads after the patient (`Jane Doe results.pdf`), and the issue is
 * public and permanent. Any token carrying one of the extensions a report or a
 * scan arrives as is refused; what the file was called is never what the bug
 * report needed to say.
 */
// One character before the dot finds every name `\S+` did, and stays linear on a long run (US-32 AC58).
const FILENAME = /\S\.(?:pdf|jpe?g|png|heic|zip|csv|txt|docx?)\b/i;

/** Calendar days and timestamps: digits, but nobody's phone number. */
const TIMESTAMP = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g;
/** A run of digits wearing phone punctuation. */
const DIGIT_RUN = /\+?\d[\d\s().-]{5,}\d/g;

/** A phone-number-shaped run: 7–15 digits, once dates and times are taken out. */
function phoneShaped(text: string): boolean {
  for (const [run] of text.replace(TIMESTAMP, ' ').matchAll(DIGIT_RUN)) {
    const digits = run.replace(/\D/g, '').length;
    if (digits >= 7 && digits <= 15) return true;
  }
  return false;
}

/**
 * The mechanical backstop on a report that becomes a PUBLIC issue nobody
 * reviews first. The tool's description is the control — it tells the model
 * what not to write — and this is what stands when the model writes it anyway:
 * a value (wearing a unit, or bare beside a name this record knows) and the
 * three ways a person is identified in a sentence about a bug (an email
 * address, a phone number, a link carrying a token). It is deliberately not a
 * diagnosis word list: that cannot be mechanical and pretending otherwise
 * would sell a promise this cannot keep.
 */
function unsafeFeedback(text: string): { reason: McpRefusalReason; text: string } | null {
  const value = VALUE_WITH_UNIT.exec(text)?.[0] ?? valueNearMetric(text);
  if (value) {
    return {
      reason: 'health-value',
      text: `“${value}” reads as a health value, so nothing was prepared. A report leaves the user’s machine when ` +
        'they submit it: say which tool or screen was wrong and what you expected, not what the record holds.',
    };
  }
  if (EMAIL.test(text) || phoneShaped(text) || URL_WITH_QUERY.test(text) || FILENAME.test(text)) {
    return {
      reason: 'contact',
      text: 'That report carries contact details — an email address, a phone number, a file name, or a link with a query ' +
        'string that may carry a token — so nothing was prepared. The issue is public and permanent: describe the ' +
        'behaviour, not the person.',
    };
  }
  return null;
}

/** An issue, as GitHub takes one. Built here; sent by whoever holds a token. */
export interface FeedbackIssue {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Filing, as a capability the surface hands in. The hosted server has a token
 * and a repository; the stdio server has neither, so it passes nothing and the
 * user gets a URL to open. A filer answers in words, never by throwing: an
 * external system that will not take an issue is something the agent should
 * read out, not a fault in us.
 */
export type FeedbackFiler = (issue: FeedbackIssue) => Promise<
  { ok: true; url: string; number: number } | { ok: false; refusal: string }
>;

/** Title as it reads on the issue list: whose report this is, then the report. */
const FEEDBACK_TITLE_PREFIX = '[connector] ';

/**
 * The report as a fenced block. The detail is a model's prose about a user's
 * problem — data, never markup and never instructions — and a fence is the one
 * thing that makes GitHub render it as written: no headings, no images, and no
 * `@name` linking to a person who never asked to be told about this. The fence
 * is longer than the longest run of backticks inside it, so text that is itself
 * about code cannot end it early.
 */
function fenced(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * A title that cannot act when something renders it as Markdown. The detail
 * gets this for free from its fence; the title does not, and the relay that
 * mails a new issue interpolates it RAW inside `**…**` in a comment body —
 * where GitHub links `@name`, `#123`, `owner/repo#1`, `[text](url)` and a
 * bare `https://` on sight. A mention pings a stranger, a cross-reference
 * posts an event in someone else's repo, and a link is a live phishing link
 * in a bot comment on a doctor's public repo. `unsafeFeedback` catches none
 * of them: it looks for values, emails, phone numbers and query strings.
 *
 * So a zero-width space goes after every character that can START one of
 * those, which breaks the construct and shows nothing to a reader. `_` is
 * deliberately absent: it opens nothing but italics, and every tool this
 * project has is named with one. Applied to the assistant's own words only —
 * never to our `[connector]` prefix — and after the cap is taken off the raw
 * title, so the cap can never cut between a character and its escape.
 */
function titleSafe(text: string): string {
  return text.replace(/[@#[\]()*`<>!|~\\]/g, '$&\u200b').replace(/:(?=\/\/)/g, ':\u200b');
}

/**
 * The report as the proposal receipt hashes it (US-36 AC9): the prepared
 * text with whitespace collapsed and case folded, so a small model that
 * re-emits its own report a turn later with different spacing still
 * confirms, while a different report does not. What is FILED is the confirm
 * call's own text; this is only the identity.
 */
export function canonicalFeedback(request: Record<string, unknown>): Record<string, unknown> {
  // Runs before the schema does (the receipt is checked first), so a missing or non-string field is folded as itself, not thrown on.
  const fold = (text: unknown) => (typeof text === 'string' ? printable(text).replace(/\s+/g, ' ').trim().toLowerCase() : text);
  return { kind: request.kind, title: fold(request.title), detail: fold(request.detail) };
}

/**
 * Everything both surfaces do before anything leaves the machine: strip the
 * text, run `unsafeFeedback` over it, and build the issue.
 */
function prepareFeedback(
  request: z.infer<typeof reportFeedbackInput>,
  now: string,
): { ok: false; reason: McpRefusalReason; text: string } | { ok: true; title: string; detail: string; issue: FeedbackIssue } {
  const title = oneLine(request.title).trim();
  const detail = printable(request.detail).trim();
  const unsafe = unsafeFeedback(`${title}\n${detail}`);
  if (unsafe) return { ok: false, ...unsafe };
  const stamp = `Health by Dr Brad connector, server ${SERVER_VERSION}, tool layer v${TOOL_LAYER_VERSION}, ${dayOf(now)}`;
  return {
    ok: true,
    title,
    detail,
    issue: {
      title: FEEDBACK_TITLE_PREFIX + titleSafe(title.slice(0, MAX_NAME_LENGTH - FEEDBACK_TITLE_PREFIX.length)),
      body: `${fenced(detail)}\n\n---\nkind: ${request.kind}\n${stamp}\n` +
        'Filed by the user’s AI assistant through the Health by Dr Brad connector; no health values are included by policy.',
      labels: ['from-connector', request.kind === 'bug' ? 'bug' : 'enhancement'],
    },
  };
}

/** The refusal when GitHub provably filed nothing (a 4xx, or no connection): the agent may retry later. A
 *  failure that may have posted gets its own "may already be posted" wording (US-32 AC39, github-issues.server.ts). */
export const FEEDBACK_UNAVAILABLE = 'Feedback could not be filed right now. Nothing was posted. Try again later.';

/** A surface with no filer while the repository is hidden: permanent, so no "try again" (US-32 AC39). */
export const FEEDBACK_HIDDEN = 'This server cannot file reports while the project\'s GitHub is not public. Nothing was posted.';

/** Where a report goes while GitHub hides the repository (US-32 AC39); it still turns public, so the privacy rules stand. */
export const HIDDEN_ISSUE = 'an issue on the project’s GitHub, which is temporarily not public and becomes public when it is';

/**
 * Prepare a bug report as a prefilled GitHub issue URL — what a surface with no
 * GitHub token can do. It holds no secret, makes no request and writes nothing:
 * the user opens the URL, reads what it says and submits it themselves.
 */
export function reportFeedback(request: z.infer<typeof reportFeedbackInput>, now: string, dryRun = false, canFile = false): ToolOutcome {
  const prepared = prepareFeedback(request, now);
  if (!prepared.ok) return { status: 'rejected', reason: prepared.reason, text: prepared.text };
  // US-32 AC39: the new-issue link 404s while GitHub hides the repository, so only a
  // surface that can file may even propose; the rest refuse, at the proposal too.
  if (!REPO_PUBLIC && !(dryRun && canFile)) return { status: 'rejected', text: FEEDBACK_HIDDEN };

  const body = `${prepared.detail}\n\n---\nReported via health-roadmap MCP ${SERVER_VERSION}, tool layer v${TOOL_LAYER_VERSION}, ${dayOf(now)}`;
  const url = `https://github.com/${FEEDBACK_REPO}/issues/new?labels=from-connector,${request.kind}`
    + `&title=${encodeURIComponent(titleSafe(prepared.title))}&body=${encodeURIComponent(body)}`;
  if (url.length > MAX_FEEDBACK_URL_LENGTH) {
    return {
      status: 'rejected',
      text: 'That report is too long to carry in a URL — GitHub would drop the end of it without saying so. ' +
        'Shorten the detail and call again.',
    };
  }
  // A dry run is the hosted proposal (US-36 AC9): what WOULD be filed, never a link to submit.
  const text = dryRun
    // The receipt is the ONE place a human sees the report before it is public,
    // so it shows the prepared text itself — a title alone hides what gets filed.
    ? (REPO_PUBLIC
      ? `Would file a PUBLIC GitHub issue (${request.kind}): “${prepared.title}”.`
      : `Would file “${prepared.title}” (${request.kind}) as ${HIDDEN_ISSUE}.`) +
      `\n\n${prepared.detail}\n\nThat detail is filed as written. Read it to the user before they confirm.`
    : `${url}\n\nShow the user this link. Ask them to read the title and body first — they must contain no ` +
      'health values, no names and no file paths — and to submit it themselves; it needs a GitHub account. ' +
      'Nothing has been sent anywhere.';
  // A proposal carries no link (US-32 AC39): the server files the issue itself on confirm, and a link
  // submitted beside it would file a second one under the user's own GitHub account.
  return { status: 'ok', text, data: { filed: false, url: dryRun ? '' : url, kind: request.kind, title: prepared.title } };
}

/**
 * File the report, on a surface that can (US-32 AC9). The issue is public and
 * the user does not see it before it exists, so the health-value guard above
 * runs first and the filer is handed nothing but the text it refused to refuse.
 */
export async function fileFeedback(
  request: z.infer<typeof reportFeedbackInput>,
  now: string,
  filer: FeedbackFiler,
): Promise<ToolOutcome> {
  const prepared = prepareFeedback(request, now);
  if (!prepared.ok) return { status: 'rejected', reason: prepared.reason, text: prepared.text };

  const result = await filer(prepared.issue);
  if (!result.ok) return { status: 'rejected', text: result.refusal };
  return {
    status: 'ok',
    text: REPO_PUBLIC
      ? `Filed as ${result.url}. Tell the user their report is in — it is a public issue on the project’s ` +
        'GitHub, carrying their description and nothing about them or their health record.'
      // US-32 AC39: GitHub hides the repository while the account is flagged; the issue exists, its link 404s.
      : `Filed as issue #${result.number}. Tell the user their report is in, carrying their description and nothing ` +
        'about them or their health record. The project’s GitHub is temporarily not public, so the link will not open for them yet.',
    // US-32 AC39: the link 404s while hidden, so the number carries the issue.
    data: { filed: true, url: REPO_PUBLIC ? result.url : '', number: result.number, kind: request.kind, title: prepared.title },
  };
}
