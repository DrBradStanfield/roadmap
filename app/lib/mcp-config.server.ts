/**
 * The hosted MCP server's configuration and its on switch (US-32, design §4).
 *
 * We are the OAuth 2.1 authorization server for `https://mcp.drstanfield.com`.
 * An IdP would mean user accounts, which this product does not have; the
 * identity we actually need is "the person who can authorize this Dropbox
 * folder", and Dropbox proves that for us. So the server keeps no storage
 * anywhere: state lives in sealed blobs (`mcp-seal.server.ts`), and the only
 * durable things are the two secrets read here.
 *
 * `MCP_SEAL_KEYS` seals every blob; `MCP_CLIENT_HMAC_KEY` is what makes a
 * self-contained DCR client id ours. Both are read here and nowhere else.
 *
 * NOTHING HERE MAY LOG A URL. OAuth secrets travel in query strings; the
 * scrubber (`sentry-scrub.ts`) is a backstop, not a licence.
 */

/**
 * The whole feature's on switch. Unset (the state of production until Brad
 * sets the Fly secret) and every `/mcp` route 404s, so this code can ship
 * inert and be turned on by adding a secret rather than by deploying again.
 *
 * A MALFORMED secret is the same answer as a missing one: disabled, 404, and
 * one log line naming the variable. The alternative is a 500 on every route in
 * the file, which is a worse failure and a more informative one to a stranger.
 */
export function isMcpEnabled(): boolean {
  let keys: Buffer[];
  try {
    keys = sealKeys();
  } catch {
    return misconfigured('MCP_SEAL_KEYS');
  }
  if (keys.length === 0) return false;
  try {
    clientHmacKey();
  } catch {
    return misconfigured('MCP_CLIENT_HMAC_KEY');
  }
  return true;
}

const warnedAbout = new Set<string>();

/** Names the variable, once, and never its value. Sentry sees the name only. */
function misconfigured(variable: string): false {
  if (!warnedAbout.has(variable)) {
    warnedAbout.add(variable);
    console.error(`[mcp] ${variable} is missing or malformed; the hosted MCP server stays disabled.`);
  }
  return false;
}

/** Public origin. The PRM `resource` must equal the URL a user types, exactly. */
export function issuer(): string {
  return process.env.MCP_ISSUER || 'https://mcp.drstanfield.com';
}

export function resourceUrl(): string {
  return `${issuer()}/mcp`;
}

export function callbackUrl(): string {
  return `${issuer()}/mcp/callback`;
}

/**
 * `MCP_SEAL_KEYS` is an ordered, comma-separated list of base64 32-byte keys.
 * We seal with the FIRST and accept ANY, so rotation is one atomic
 * `fly secrets set` that prepends a key — there is no window in which a machine
 * holds half a view of the key set.
 *
 * `kid` is a FINGERPRINT of the key, not its index. The design says "index",
 * and index cannot survive the rotation the same paragraph prescribes:
 * prepending a key renumbers every key, so every blob already issued would
 * decrypt under the wrong one. A fingerprint names the key itself, so prepend
 * and append both work and "accept any" stays literally true.
 */
export function sealKeys(): Buffer[] {
  const raw = process.env.MCP_SEAL_KEYS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const key = Buffer.from(part, 'base64');
      if (key.length !== 32) throw new Error('MCP_SEAL_KEYS holds a key that is not 32 bytes');
      return key;
    });
}

/**
 * A DCR `client_id` that carries its own registration: `c.<metadata>.<HMAC>`.
 * RFC 7591 §3.2.1 permits a self-contained id, so there is no registry and no
 * row — the HMAC under `MCP_CLIENT_HMAC_KEY` is what makes the metadata ours.
 *
 * Rotating that key is USER-VISIBLE: Anthropic freezes a connector's auth
 * settings after it is added, so every affected user must remove and re-add
 * the connector. Rotate only with a comms plan (§2).
 */
export function clientHmacKey(): Buffer {
  const raw = process.env.MCP_CLIENT_HMAC_KEY;
  if (!raw) throw new Error('MCP_CLIENT_HMAC_KEY is not configured');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MCP_CLIENT_HMAC_KEY is not 32 bytes');
  return key;
}

/** Test seam — the warned-about set is process-global. */
export function resetMcpWarnings(): void {
  warnedAbout.clear();
}
