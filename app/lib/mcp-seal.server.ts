/**
 * The seal: the hosted MCP server keeps no state anywhere (US-32, design §4).
 *
 * Every piece of state an OAuth server normally keeps in a table — the
 * `state`, the authorization code, the access token, the refresh token — is
 * instead SEALED into the value we hand the client. We hold the key and no
 * blob; the AI vendor holds a blob and no key. Neither organisation alone can
 * read a user's record.
 *
 * The provider refresh token lives inside the access and refresh blobs. That
 * is the sharp edge of the design and it is stated plainly in §4: a leaked
 * `MCP_SEAL_KEYS` opens every blob ever issued, including expired ones, so
 * no-overlap rotation is the standing incident response.
 *
 * NOTHING HERE MAY LOG A URL.
 */
import crypto from 'node:crypto';
import { resourceUrl, sealKeys } from './mcp-config.server';
import { isProvider, type McpProvider } from './mcp-providers.server';

/** `import` is an HKDF label only: an import receipt (US-35 AC7) is HMAC'd
 *  under it, never sealed — its payload sits in the user's own folder. */
export type BlobType = 'state' | 'code' | 'access' | 'refresh' | 'import';

/**
 * Fixed-length buckets for the padded plaintext. Without padding the blob's
 * length leaks which provider and roughly which credential is inside. The
 * design names four buckets; the 4096 rung is here so an unusually long
 * provider refresh token fails to leak rather than failing to work.
 */
const BUCKETS = [256, 512, 1024, 2048, 4096];

/**
 * HKDF-SHA256 per blob type, so a `state` blob can never be read as an
 * `access`. Exported because the header check in `unseal` masks it: drop `typ`
 * from the info string and every other test still passes.
 */
export function typeKey(key: Buffer, typ: BlobType): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), `mcp/${typ}/v1`, 32));
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function hash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** Names one seal key without revealing it. Public — it rides in the header. */
function fingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 11);
}

/**
 * The blob's cleartext header, and its own AAD. It carries `kid` (which key),
 * `typ` (which HKDF context) and the HASHES of the client id and the resource
 * — hashes, not the values, because the header is public and the client id
 * does not need to be. Authenticating it as AAD is what binds one blob to one
 * client and one audience: present an access blob to a different client and
 * the tag check fails before any plaintext exists.
 */
interface SealHeader {
  k: string;
  t: BlobType;
  c: string;
  r: string;
}

function padToBucket(plaintext: Buffer): Buffer {
  const framed = Buffer.concat([Buffer.alloc(4), plaintext]);
  framed.writeUInt32BE(plaintext.length, 0);
  const size = BUCKETS.find((bucket) => bucket >= framed.length);
  if (!size) throw new Error('Sealed payload is too large');
  return Buffer.concat([framed, Buffer.alloc(size - framed.length)]);
}

function unpad(padded: Buffer): Buffer {
  const length = padded.readUInt32BE(0);
  if (length > padded.length - 4) throw new Error('Sealed payload is malformed');
  return padded.subarray(4, 4 + length);
}

export interface SealAudience {
  clientId: string;
  resource: string;
}

/**
 * Seal a payload. The wire form is `base64url(header) + "." +
 * base64url(nonce ‖ ciphertext ‖ tag)` — the header must travel in the clear
 * because unsealing has to know which key and which context to try, and it is
 * authenticated rather than trusted.
 */
export function seal(typ: BlobType, payload: unknown, audience: SealAudience): string {
  const keys = sealKeys();
  if (keys.length === 0) throw new Error('MCP_SEAL_KEYS is not configured');
  const header: SealHeader = { k: fingerprint(keys[0]), t: typ, c: hash(audience.clientId), r: hash(audience.resource) };
  const aad = Buffer.from(JSON.stringify(header), 'utf8');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', typeKey(keys[0], typ), nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const body = Buffer.concat([
    cipher.update(padToBucket(Buffer.from(JSON.stringify(payload), 'utf8'))),
    cipher.final(),
  ]);
  return `${b64url(aad)}.${b64url(Buffer.concat([nonce, body, cipher.getAuthTag()]))}`;
}

/**
 * Unseal, or return null. Every failure — a bad tag, the wrong type, another
 * client, an unknown key, a rotated-away key — is one `null`, because telling
 * an attacker which check failed is telling them how to pass it.
 *
 * `exp` is checked here and nowhere else, which is the honest position: it is
 * OUR expiry, advisory, enforced only by this function. Anyone holding the
 * seal key can read an "expired" blob.
 */
export function unseal<T>(typ: BlobType, token: string, audience: SealAudience, nowMs = Date.now()): T | null {
  const [headerPart, bodyPart, ...rest] = token.split('.');
  if (!headerPart || !bodyPart || rest.length > 0) return null;
  let header: SealHeader;
  let aad: Buffer;
  try {
    aad = Buffer.from(headerPart, 'base64url');
    header = JSON.parse(aad.toString('utf8')) as SealHeader;
  } catch {
    return null;
  }
  if (header.t !== typ) return null;
  if (header.c !== hash(audience.clientId) || header.r !== hash(audience.resource)) return null;
  const key = sealKeys().find((candidate) => fingerprint(candidate) === header.k);
  if (!key) return null;

  const raw = Buffer.from(bodyPart, 'base64url');
  if (raw.length < 12 + 16) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', typeKey(key, typ), raw.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const padded = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
    const payload = JSON.parse(unpad(padded).toString('utf8')) as T & { exp?: number };
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Every value we hand out carries its client id in front, base64url, before a
 * `~`: `<client id>~<sealed blob>`.
 *
 * The AAD binds a blob to one client, and unsealing therefore has to know
 * which client — but a bearer token arrives alone, and Dropbox echoes exactly
 * one opaque `state`. So the id travels with the blob. It is not trusted: it
 * feeds the AAD, so changing it makes the GCM tag fail and the blob will not
 * open. Where the request states the client independently — `/token`, which
 * takes `client_id` in the form body — the route compares the two, and that
 * comparison is a real check rather than a carried claim. On `/mcp` there is
 * nothing to compare against, so the binding is only carried: a stolen bearer
 * token is a stolen bearer token, and no framing fixes that.
 */
export function packSealed(typ: BlobType, clientId: string, payload: unknown): string {
  const sealed = seal(typ, payload, { clientId, resource: resourceUrl() });
  return `${b64url(Buffer.from(clientId, 'utf8'))}~${sealed}`;
}

export function unpackSealed<T extends { clientId: string }>(
  typ: BlobType,
  token: string,
  nowMs = Date.now(),
): T | null {
  const at = token.indexOf('~');
  if (at <= 0 || token.length > 16384) return null;
  let clientId: string;
  try {
    clientId = Buffer.from(token.slice(0, at), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const payload = unseal<T & { provider?: unknown }>(typ, token.slice(at + 1), { clientId, resource: resourceUrl() }, nowMs);
  // The AAD already proves this; the explicit check keeps the invariant
  // readable at every call site that depends on it.
  if (!payload || payload.clientId !== clientId) return null;
  // Phase-1 blobs carry no `provider` — the hosted server had one backend and
  // did not need to say so. They are live in vendor token stores right now, and
  // a blob a vendor holds can never be updated by us (§7), so refusing them, or
  // reading `undefined` as a provider, would break Brad's own connections on the
  // first tool call after this deploys. Every one of them is Dropbox. This is
  // the only place a sealed payload is opened, so it is the only place the
  // default belongs.
  if (!isProvider(payload.provider)) (payload as { provider: McpProvider }).provider = 'dropbox';
  return payload;
}
