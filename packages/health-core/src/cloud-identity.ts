/**
 * US-09 AC67: a measurement that precedes a design. Count whether the cloud
 * account id can be read on the web, and how many record copies Drive lists
 * as owned. The iPhone already reads this id; the web will need it for a
 * planned storage change.
 *
 * A pure leaf: the provider's answer (an HTTP status and its parsed body) is
 * judged here into closed words and nothing else. The id, an email, a file id
 * or any other text in the body never leaves these functions.
 */
import * as z from './zod';

/** The providers whose account id is read. WebDAV has none to read. */
export const IDENTITY_PROVIDERS = ['google-drive', 'dropbox', 'github'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];
/** How the page's token was granted: a sign-in redirect, Google's popup, a pasted GitHub token. */
export const IDENTITY_GRANTS = ['redirect', 'popup', 'pat'] as const;
export type IdentityGrant = (typeof IDENTITY_GRANTS)[number];
/** `cloud_identity_read`'s outcome. `skipped`: no unexpired token was in hand, so nothing was asked. */
export const IDENTITY_OUTCOMES = ['ok', 'missing', 'refused', 'unreachable', 'malformed', 'skipped'] as const;
export type IdentityOutcome = (typeof IDENTITY_OUTCOMES)[number];
/** `drive_record_copies`: how many copies of the record Drive listed, owned and not, as a bucket. */
export const COPY_BUCKETS = ['0', '1', '2+'] as const;
export type CopyBucket = (typeof COPY_BUCKETS)[number];
/** `incomplete`: Drive said the list was partial, or it did not parse. */
export const COPIES_OUTCOMES = ['ok', 'refused', 'unreachable', 'incomplete'] as const;
export type CopiesOutcome = (typeof COPIES_OUTCOMES)[number];

/** Whether Dropbox's token reply at a redirect return carried an `account_id`. */
export const TOKEN_REPLY_WORDS = ['had_id', 'no_id'] as const;
export type TokenReplyWord = (typeof TOKEN_REPLY_WORDS)[number];

export interface CopiesCount {
  outcome: CopiesOutcome;
  /** Always on `ok`; on `incomplete` when a page was read (its counts so far); never otherwise. */
  owned?: CopyBucket;
  notOwned?: CopyBucket;
}

const id = z.string().min(1);
/** Where each provider puts the account id in its answer. Only presence is judged. */
const IDENTITY_BODIES: Record<IdentityProvider, z.ZodType> = {
  // GET drive/v3/about?fields=user(permissionId)
  'google-drive': z.object({ user: z.object({ permissionId: id }) }),
  // POST 2/users/get_current_account
  dropbox: z.object({ account_id: id }),
  // GET /user
  github: z.object({ id: z.number().int().positive() }),
};

/** A status the provider answered with but that did not give the body: a refused token, or anything else. */
function failedStatus(status: number): 'refused' | 'unreachable' {
  return status === 401 || status === 403 ? 'refused' : 'unreachable';
}

const isObject = (body: unknown): boolean => typeof body === 'object' && body !== null && !Array.isArray(body);

/**
 * One identity read's outcome. `status` is null when no answer came (a
 * network failure or the timeout); `body` is the parsed JSON, or undefined
 * when it did not parse.
 */
export function classifyIdentityRead(provider: IdentityProvider, status: number | null, body: unknown): IdentityOutcome {
  if (status === null) return 'unreachable';
  if (status < 200 || status > 299) return failedStatus(status);
  if (!isObject(body)) return 'malformed';
  return IDENTITY_BODIES[provider].safeParse(body).success ? 'ok' : 'missing';
}

/** A Dropbox token reply, judged for its `account_id` only; the reply itself is not kept. */
export function classifyTokenReply(reply: unknown): TokenReplyWord {
  return IDENTITY_BODIES.dropbox.safeParse(reply).success ? 'had_id' : 'no_id';
}

const copiesBody = z.object({
  files: z.array(z.object({ ownedByMe: z.boolean() })),
  nextPageToken: z.string().optional(),
  incompleteSearch: z.boolean().optional(),
});

export function copyBucket(n: number): CopyBucket {
  return n <= 0 ? '0' : n === 1 ? '1' : '2+';
}

/**
 * The record-copies listing's outcome and buckets. A second page or a partial
 * search counts as `incomplete`, with the counts of the page seen: one page of
 * 100 is all that is asked for. A body that does not parse is `incomplete`
 * with no counts.
 */
export function classifyCopies(status: number | null, body: unknown): CopiesCount {
  if (status === null) return { outcome: 'unreachable' };
  if (status < 200 || status > 299) return { outcome: failedStatus(status) };
  const parsed = copiesBody.safeParse(body);
  if (!parsed.success) return { outcome: 'incomplete' };
  const owned = parsed.data.files.filter((f) => f.ownedByMe).length;
  // A partial list is never followed: its counts are what this page showed, said as incomplete.
  const partial = !!parsed.data.nextPageToken || parsed.data.incompleteSearch === true;
  return { outcome: partial ? 'incomplete' : 'ok', owned: copyBucket(owned), notOwned: copyBucket(parsed.data.files.length - owned) };
}
