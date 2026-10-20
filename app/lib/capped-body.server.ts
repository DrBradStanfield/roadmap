/**
 * Every server route reads its request body through here, capped (US-09 AC25).
 * Reading stops at the cap, so an endless or chunked body costs at most the cap.
 */

/** 64 KB: no small JSON or form route's honest body comes near it; the largest is an MCP client registration document. */
export const SMALL_BODY_CAP = 64 * 1024;

/**
 * Read at most `cap` bytes of a request or a response body, or throw. A
 * `content-length` is the sender's claim, so it is checked where it exists but
 * never believed — a chunked body has none at all. Takes a web `Request` or
 * `Response`, or a Node stream such as an `IncomingMessage`.
 */
export async function readCapped(
  source: { body: ReadableStream<Uint8Array> | null } | AsyncIterable<Uint8Array>,
  cap: number,
): Promise<string> {
  // A web stream is async-iterable in Node; the DOM types just do not say so.
  const chunks = 'body' in source ? (source.body as unknown as AsyncIterable<Uint8Array> | null) : source;
  if (!chunks) return '';
  const read: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early (the throw) cancels a web stream and destroys a Node one.
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > cap) throw new Error('body too large');
    read.push(chunk);
  }
  return Buffer.concat(read).toString('utf8');
}

/**
 * A request's body as text, or null when it is over `cap` (the caller answers
 * 413). A declared length over the cap is refused unread; a lower one is not
 * believed.
 */
export async function cappedBody(request: Request, cap = SMALL_BODY_CAP): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > cap) return null;
  try {
    return await readCapped(request, cap);
  } catch {
    return null;
  }
}
