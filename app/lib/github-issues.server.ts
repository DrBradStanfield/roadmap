/**
 * Filing one `report_feedback` issue on GitHub, for the hosted MCP server
 * (US-32 AC9).
 *
 * The tool layer builds the issue and refuses anything that reads as a health
 * value; this file is the part that needs a secret and a network, and it is
 * kept out of `mcp-tools.ts` for exactly that reason — the stdio server and the
 * CLI import the tool layer and must stay tokenless.
 *
 * Nothing here logs the report's text, the token, or a user. The issue is
 * public, so what leaves is only what the tool already allowed: the assistant's
 * own description of the problem.
 */
import type { FeedbackFiler, FeedbackIssue } from '../../packages/health-core/src/mcp-tools';
import type { McpProvider } from './mcp-providers.server';

const REPO = 'DrBradStanfield/roadmap';
const API = `https://api.github.com/repos/${REPO}/issues`;

/**
 * Issues this machine will file in an hour, over every connection there is.
 * The per-connection write allowance already bounds one user; this bounds the
 * repository, which is the thing a hundred connections could bury.
 */
export const ISSUES_PER_HOUR = 20;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * How long the same report counts as the same report. An assistant that files,
 * loses the thread and files again is the ordinary case, not an attack, and a
 * second issue helps nobody — so the first one's URL comes back instead.
 */
const DEDUPE_MS = 24 * 60 * 60 * 1000;
const DEDUPE_CAP = 256;

const filedAt: number[] = [];
const recent = new Map<string, { url: string; number: number; at: number }>();

/** Test seam — both are process-global and would leak between cases. */
export function resetGithubIssues(): void {
  filedAt.length = 0;
  recent.clear();
}

/** Same words, same report. Case and spacing are not a difference worth filing. */
function dedupeKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The filer the hosted server hands to the tool layer, or `null` when no token
 * is configured — which is how the tool falls back to a URL the user submits.
 * `fetch` is read at call time so the suite can stub it.
 */
export function githubFiler(provider: McpProvider, nowMs = () => Date.now()): FeedbackFiler | null {
  const token = process.env.GITHUB_ISSUES_TOKEN;
  if (!token) return null;
  return (issue) => fileIssue(issue, token, provider, nowMs());
}

async function fileIssue(
  issue: FeedbackIssue,
  token: string,
  provider: McpProvider,
  now: number,
): Promise<{ ok: true; url: string; number: number } | { ok: false; refusal: string }> {
  const key = dedupeKey(issue.title);
  for (const [id, entry] of recent) if (now - entry.at > DEDUPE_MS) recent.delete(id);
  const already = recent.get(key);
  if (already) {
    return { ok: true, url: already.url, number: already.number };
  }

  while (filedAt.length && now - filedAt[0] > WINDOW_MS) filedAt.shift();
  if (filedAt.length >= ISSUES_PER_HOUR) {
    return { ok: false, refusal: 'Feedback is paused for an hour. Nothing was filed. Ask the user to try again later.' };
  }

  // The provider is the one thing the server knows and the tool layer does not,
  // and it is what makes a report reproducible. It names a cloud, never a user.
  const body = `${issue.body}\nprovider: ${provider}`;

  let response: Response;
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'health-roadmap-mcp',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: issue.title, body, labels: issue.labels }),
    });
  } catch {
    return { ok: false, refusal: 'GitHub did not answer. Nothing was filed. Try again later.' };
  }

  if (!response.ok) {
    // The status alone: a GitHub error body can quote the report back at us.
    console.error('[mcp] github issue refused', response.status);
    return { ok: false, refusal: 'GitHub did not answer. Nothing was filed. Try again later.' };
  }

  const created = (await response.json().catch(() => null)) as { html_url?: unknown; number?: unknown } | null;
  const url = typeof created?.html_url === 'string' ? created.html_url : '';
  const number = typeof created?.number === 'number' ? created.number : 0;
  if (!url || !number) {
    console.error('[mcp] github issue answered without a url');
    return { ok: false, refusal: 'GitHub did not answer. Nothing was filed. Try again later.' };
  }

  filedAt.push(now);
  if (recent.size >= DEDUPE_CAP) recent.delete(recent.keys().next().value as string);
  recent.set(key, { url, number, at: now });
  return { ok: true, url, number };
}
