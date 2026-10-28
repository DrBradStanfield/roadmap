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
import { FEEDBACK_REPO, FEEDBACK_UNAVAILABLE, type FeedbackFiler, type FeedbackIssue } from '../../packages/health-core/src/mcp-tools';
import type { McpProvider } from './mcp-providers.server';

const API = `https://api.github.com/repos/${FEEDBACK_REPO}/issues`;

/**
 * Issues this machine will file in an hour, over every connection there is.
 * The per-connection write allowance already bounds one user; this bounds the
 * repository, which is the thing a hundred connections could bury.
 */
export const ISSUES_PER_HOUR = 20;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * How long the same report counts as the same report — the SAME connection's,
 * which is the whole point. An assistant that files, loses the thread and files
 * again is the ordinary case, not an attack, and a second issue helps nobody —
 * so the first one's URL comes back instead. Two connections that happen to
 * choose one title are two users, and the second must not be swallowed: the key
 * carries the connection.
 */
const DEDUPE_MS = 24 * 60 * 60 * 1000;
const DEDUPE_CAP = 256;

/**
 * Reports one CONNECTION will file in a day. The hourly machine cap bounds the
 * repository; this bounds one talkative assistant, which could otherwise spend
 * the whole machine's hour by itself.
 */
export const REPORTS_PER_DAY = 3;
const CONNECTION_CAP = 512;

/** How long we wait on GitHub before calling it unanswered. */
const GITHUB_TIMEOUT_MS = 8000;

/** An explicit provider refusal is distinct from a possibly accepted POST. */
const UNAVAILABLE = { ok: false, refusal: FEEDBACK_UNAVAILABLE } as const;
const UNCERTAIN = { ok: false, refusal: 'We could not confirm whether GitHub filed the report. It may already be posted; do not submit it again right now.' } as const;

type Reservation = { at: number };
const filedAt: Reservation[] = [];
type Recent = {
  answer: { ok: true; url: string; number: number } | typeof UNCERTAIN;
  at: number;
};
const recent = new Map<string, Recent>();
const perConnection = new Map<string, Reservation[]>();
const inFlight = new Map<string, ReturnType<FeedbackFiler>>();

/** Test seam — process-global state would leak between cases. */
export function resetGithubIssues(): void {
  filedAt.length = 0;
  recent.clear();
  perConnection.clear();
  inFlight.clear();
}

/** Same words, same report. Case and spacing are not a difference worth filing. */
function dedupeKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function remember(key: string, answer: Recent['answer'], at: number): void {
  if (recent.size >= DEDUPE_CAP && !recent.has(key)) recent.delete(recent.keys().next().value as string);
  recent.set(key, { answer, at });
}

/**
 * The filer the hosted server hands to the tool layer, or `null` when no token
 * is configured — which is how the tool falls back to a URL the user submits.
 * `fetch` is read at call time so the suite can stub it. `connection` is the
 * hashed refresh token — a connection, never a user.
 */
export function githubFiler(provider: McpProvider, connection: string): FeedbackFiler | null {
  const token = process.env.GITHUB_ISSUES_TOKEN;
  if (!token) return null;
  return (issue) => fileIssue(issue, token, provider, connection, Date.now());
}

async function fileIssue(
  issue: FeedbackIssue,
  token: string,
  provider: McpProvider,
  connection: string,
  now: number,
): Promise<{ ok: true; url: string; number: number } | { ok: false; refusal: string }> {
  const key = `${connection}\n${dedupeKey(issue.title)}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  for (const [id, entry] of recent) if (now - entry.at > DEDUPE_MS) recent.delete(id);
  const already = recent.get(key);
  if (already) return already.answer;

  const mine = (perConnection.get(connection) ?? []).filter(({ at }) => now - at <= DEDUPE_MS);
  if (mine.length >= REPORTS_PER_DAY) {
    return { ok: false, refusal: 'You have filed three reports today. Nothing was filed.' };
  }

  while (filedAt.length && now - filedAt[0].at > WINDOW_MS) filedAt.shift();
  if (filedAt.length >= ISSUES_PER_HOUR) {
    return { ok: false, refusal: 'Feedback is paused for an hour. Nothing was filed. Ask the user to try again later.' };
  }

  // Reserve both allowances synchronously: another request can enter as soon
  // as fetch yields, before GitHub has answered this one.
  const reservation = { at: now };
  filedAt.push(reservation);
  mine.push(reservation);
  if (perConnection.size >= CONNECTION_CAP && !perConnection.has(connection)) {
    perConnection.delete(perConnection.keys().next().value as string);
  }
  perConnection.set(connection, mine);

  // The provider is the one thing the server knows and the tool layer does not,
  // and it is what makes a report reproducible. It names a cloud, never a user.
  const body = `${issue.body}\nprovider: ${provider}`;

  function releaseReservation(): void {
    const hourly = filedAt.indexOf(reservation);
    if (hourly !== -1) filedAt.splice(hourly, 1);
    const current = perConnection.get(connection);
    const daily = current?.indexOf(reservation) ?? -1;
    if (current && daily !== -1) {
      current.splice(daily, 1);
      if (!current.length) perConnection.delete(connection);
    }
  }

  const sending = (async (): ReturnType<FeedbackFiler> => {
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
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (error) {
      // Native fetch exposes pre-connection failures through cause.code. A
      // reset, abort, or unknown failure can happen after POST and stays uncertain.
      const cause = error instanceof Error ? error.cause : null;
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
      if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
        releaseReservation();
        return UNAVAILABLE;
      }
      remember(key, UNCERTAIN, now);
      return UNCERTAIN;
    }

    if (!response.ok) {
      // The status alone: a GitHub error body can quote the report back at us.
      console.error('[mcp] github issue refused', response.status);
      // A server error can follow an accepted POST (including a proxy 502/504).
      // Keep capacity and dedupe rather than inviting a duplicate issue.
      if (response.status >= 500) {
        remember(key, UNCERTAIN, now);
        return UNCERTAIN;
      }
      releaseReservation();
      return UNAVAILABLE;
    }

    const created = (await response.json().catch(() => null)) as { html_url?: unknown; number?: unknown } | null;
    if (typeof created?.html_url !== 'string' || !created.html_url || typeof created.number !== 'number' || !created.number) {
      console.error('[mcp] github issue answered without a url');
      // HTTP success without a usable URL may still have created the issue.
      remember(key, UNCERTAIN, now);
      return UNCERTAIN;
    }
    const { html_url: url, number } = created;
    const filed = { ok: true, url, number } as const;
    remember(key, filed, now);
    return filed;
  })();
  inFlight.set(key, sending);
  try {
    return await sending;
  } finally {
    inFlight.delete(key);
  }
}
