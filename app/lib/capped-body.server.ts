/**
 * Every server route reads its request body through here, capped (US-09 AC25).
 * Reading stops at the cap, so an endless or chunked body costs at most the cap.
 */

/** 64 KB: no small JSON or form route's honest body comes near it; the largest is an MCP client registration document. */
export const SMALL_BODY_CAP = 64 * 1024;

/**
 * 5 MB for Shopify's webhooks, read before their HMAC is checked. An orders/paid
 * payload grows with its line items, a few KB each, so even a very large order
 * stays well under it; the other topics are small.
 */
export const WEBHOOK_BODY_CAP = 5 * 1024 * 1024;

type Source = { body: ReadableStream<Uint8Array> | null } | AsyncIterable<Uint8Array>;

/**
 * Read at most `cap` bytes of a request or a response body, or throw. A
 * `content-length` is the sender's claim, so it is checked where it exists but
 * never believed — a chunked body has none at all. Takes a web `Request` or
 * `Response`, or a Node stream such as an `IncomingMessage`.
 */
export async function readCappedBytes(source: Source, cap: number): Promise<Buffer> {
  // A web stream is async-iterable in Node; the DOM types just do not say so.
  const chunks = 'body' in source ? (source.body as unknown as AsyncIterable<Uint8Array> | null) : source;
  if (!chunks) return Buffer.alloc(0);
  const read: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early (the throw) cancels a web stream and destroys a Node one.
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > cap) throw new Error('body too large');
    read.push(chunk);
  }
  return Buffer.concat(read);
}

/** `readCappedBytes` as UTF-8 text. */
export async function readCapped(source: Source, cap: number): Promise<string> {
  return (await readCappedBytes(source, cap)).toString('utf8');
}

/**
 * A request's body bytes, or null when it is over `cap` (the caller answers
 * 413). A declared length over the cap is refused unread; a lower one is not
 * believed.
 */
async function cappedBytes(request: Request, cap: number): Promise<Buffer | null> {
  if (Number(request.headers.get('content-length')) > cap) return null;
  try {
    return await readCappedBytes(request, cap);
  } catch {
    return null;
  }
}

/** A request's body as text, or null when it is over `cap`. */
export async function cappedBody(request: Request, cap = SMALL_BODY_CAP): Promise<string | null> {
  return (await cappedBytes(request, cap))?.toString('utf8') ?? null;
}

/**
 * The request again, its body read capped, for a library that reads the body
 * itself (Shopify's webhook HMAC check, its login form). The bytes are passed
 * on untouched, since the HMAC covers them. Null when over `cap`.
 */
export async function cappedRequest(request: Request, cap: number): Promise<Request | null> {
  const bytes = await cappedBytes(request, cap);
  if (!bytes) return null;
  return new Request(request.url, { method: request.method, headers: request.headers, body: new Uint8Array(bytes) });
}
