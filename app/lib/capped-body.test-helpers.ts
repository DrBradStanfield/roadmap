/**
 * A POST whose body streams `bytes` bytes of spaces (US-09 AC25), sent chunked:
 * no Content-Length unless `headers` claims one. `pulled.bytes` says how much
 * the server read before it stopped.
 */
export function streamingPost(
  url: string,
  bytes: number,
  { headers = {}, chunkBytes = 16 * 1024 }: { headers?: Record<string, string>; chunkBytes?: number } = {},
) {
  const pulled = { bytes: 0 };
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  let left = bytes;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const n = Math.min(left, chunkBytes);
      left -= n;
      pulled.bytes += n;
      controller.enqueue(chunk.subarray(0, n));
    },
  });
  const request = new Request(url, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  return { request, pulled };
}
