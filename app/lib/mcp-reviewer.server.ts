/**
 * OpenAI's and Anthropic's app reviewers sign in on our own consent page (US-32 AC38, AC49): the
 * reviewer SECRETS, and who may see the form. What a reviewer grant means once
 * minted is `mcp-grants.server.ts`'s.
 *
 * The one password login on this auth server, and the one provider credential
 * held server-side, both for an invented account: Brad's recorded exception
 * (docs/mcp-architecture.md). Twice the reviewer stopped at a Dropbox or Google
 * login that challenged them with an emailed code, which OpenAI forbids. Plan:
 * docs/reviews/2026-10-01-chatgpt-reviewer-signin-plan.md.
 *
 * Off unless all three secrets are set and well formed, so between reviews the
 * consent page is exactly what every other user sees. Nothing here logs a
 * username, a password or the token.
 */
import crypto from 'node:crypto';
import { KNOWN_CLIENTS, type McpClientLabel } from './mcp-clients.server';
import type { McpProvider } from './mcp-providers.server';
import { createQuotaCounter } from './rate-limiter';

/**
 * The only clients that see the form, and whose review it is: the pinned
 * ChatGPT and Codex entries, since OpenAI tests "ChatGPT and Codex surfaces",
 * and the pinned Claude and Claude Code entries for Anthropic's connector
 * directory (US-32 AC49). Matched by exact id (a Map key), never a lookalike or
 * a DCR client: chatgpt.com echoes any query string into a CIMD document, so
 * `…client.json?x=1` resolves as a client named "ChatGPT".
 */
const REVIEWS: Partial<Record<McpClientLabel, 'OpenAI' | 'Anthropic'>> = { chatgpt: 'OpenAI', codex: 'OpenAI', claude: 'Anthropic', claude_code: 'Anthropic' };

/**
 * Which vendors' reviews are pending: `MCP_REVIEWER_VENDORS`, a comma list of
 * `openai` and/or `anthropic` (US-32 AC49). Unset means `openai`, AC38's
 * behaviour. Any other word turns every box off: a typo fails closed, so
 * real users of the other vendor never see a box that is not for them.
 */
function pendingReviews(): Set<string> {
  const words = (process.env.MCP_REVIEWER_VENDORS ?? 'openai').split(',').map((word) => word.trim());
  return words.every((word) => word === 'openai' || word === 'anthropic') ? new Set(words) : new Set();
}

/** Whose review this client's box is for, while that review is pending; undefined is no box and no sign-in. */
export function reviewerReview(clientId: string): 'OpenAI' | 'Anthropic' | undefined {
  const client = KNOWN_CLIENTS.get(clientId);
  const review = client && REVIEWS[client.label];
  return review && pendingReviews().has(review.toLowerCase()) ? review : undefined;
}

export function reviewerClient(clientId: string) {
  return reviewerReview(clientId) ? KNOWN_CLIENTS.get(clientId) : undefined;
}

/** A noise brake, not a defence: the password is a ~130-bit random secret. Failures only, 20 per IP per 15 minutes, per machine. */
export const reviewerFailures = createQuotaCounter(20, 15 * 60_000, 10 * 60_000);

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest();

/** A typed username forgives spaces around it and caps lock. */
export function normaliseUsername(text: string): string {
  return text.trim().toLowerCase();
}

/** A typed password forgives caps lock, grouping spaces and dashes (US-32 AC38: typeable in a no-paste browser). */
export function normalisePassword(text: string): string {
  return text.toLowerCase().replace(/[\s-]+/g, '');
}

/** What `MCP_REVIEWER_PASSWORD_SHA256` holds, as bytes: SHA-256 of the normalised password. */
export function passwordDigest(password: string): Buffer {
  return sha256(normalisePassword(password));
}

/** All three secrets present and well formed. A malformed one is off, not a throw inside `timingSafeEqual`. */
export function reviewerConfigured(): boolean {
  const { MCP_REVIEWER_USERNAME: user, MCP_REVIEWER_PASSWORD_SHA256: hash, MCP_REVIEWER_DROPBOX_RT: rt } = process.env;
  return Boolean(user && rt && !user.includes('@') && hash && /^[0-9a-f]{64}$/.test(hash));
}

/** Does this client, choosing this cloud, see the reviewer form, and may it sign in? One answer for the page and the POST. */
export function reviewerOffered(clientId: string, provider: McpProvider): boolean {
  return reviewerClient(clientId) !== undefined && provider === 'dropbox' && reviewerConfigured();
}

/**
 * The generation every reviewer grant carries instead of the token: changing
 * the password OR the token ends every reviewer session on its next request.
 * Null whenever the secrets are gone.
 */
export function reviewerGeneration(): string | null {
  if (!reviewerConfigured()) return null;
  return sha256(`${process.env.MCP_REVIEWER_PASSWORD_SHA256}${process.env.MCP_REVIEWER_DROPBOX_RT}`).toString('hex').slice(0, 16);
}

/** The reviewer's Dropbox refresh token. Read only where a provider refresh needs it. */
export function reviewerRefreshToken(): string {
  return process.env.MCP_REVIEWER_DROPBOX_RT ?? '';
}

/**
 * Both comparisons always run, on 32-byte digests, so a wrong username and a
 * wrong password take the same path. Call only when `reviewerConfigured()`.
 */
export function reviewerLoginMatches(username: string, password: string): boolean {
  const userOk = crypto.timingSafeEqual(sha256(normaliseUsername(process.env.MCP_REVIEWER_USERNAME ?? '')), sha256(normaliseUsername(username)));
  const passwordOk = crypto.timingSafeEqual(Buffer.from(process.env.MCP_REVIEWER_PASSWORD_SHA256 ?? '', 'hex'), passwordDigest(password));
  return userOk && passwordOk;
}
