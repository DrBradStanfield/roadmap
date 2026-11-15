/**
 * POST lab-read (US-52 AC7e): /lab-import's gate and read, answered as a stream.
 * A refusal is /lab-import's own answer and status. Once the gate has spent the
 * App Attest counter, the headers go at once (200, NDJSON), so the phone's lock,
 * held from signing until headers arrive, frees the next send while this read
 * runs. Lines: `{"accepted":true}`, a blank line every 15 s while the read runs,
 * then `{"status", "body"}` with the status and body /lab-import would answer.
 */
import type { KeyStore } from './app-gate.server';
import { labGate, labRead } from './app-routes.server';
import { NDJSON_HEADERS } from './chat-turn-io.server';

const KEEP_ALIVE_MS = 15_000;

export async function appLabRead(request: Request, store?: KeyStore): Promise<Response> {
  const gate = await labGate(request, store);
  if (gate instanceof Response) return gate;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (line: string) => {
        try { controller.enqueue(encoder.encode(line + '\n')); } catch { /* reader gone */ }
      };
      write(JSON.stringify({ accepted: true }));
      keepAlive = setInterval(() => write(''), KEEP_ALIVE_MS);
      // The read runs on when the reader goes away: its budget ends it (AC7c).
      void (async () => {
        let last;
        try {
          const res = await labRead(gate);
          last = { status: res.status, body: await res.json() };
        } catch {
          // A guard only: labRead answers its own failures. It keeps the stream from staying open.
          last = { status: 500, body: { success: false, error: 'Failed to process request' } };
        }
        clearInterval(keepAlive);
        write(JSON.stringify(last));
        try { controller.close(); } catch { /* reader gone */ }
      })();
    },
    cancel: () => clearInterval(keepAlive),
  });
  return new Response(body, { headers: NDJSON_HEADERS });
}
