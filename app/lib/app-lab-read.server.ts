/**
 * POST lab-read (US-52 AC7e): /lab-import's gate and read, answered as a stream.
 * A refusal is /lab-import's own answer and status. Once the gate has spent the
 * App Attest counter, the headers go at once (200, NDJSON), so the phone's lock,
 * held from signing until headers arrive, frees the next send while this read
 * runs. Lines: `{"accepted":true}`, a blank line every 15 s while the read runs,
 * then `{"status", "body"}` with the status and body /lab-import would answer.
 * Reads in flight are capped per machine and per key: the gate admits a read
 * once its signature verifies and before it charges anything, and a refusal is
 * the 503 the app already treats as "try again", before any stream (lab-read-slots).
 */
import * as Sentry from '@sentry/react-router';
import type { KeyStore } from './app-gate.server';
import { labGate, labRead, type AcceptedLab } from './app-routes.server';
import { NDJSON_HEADERS } from './chat-turn-io.server';
import { labReadSlots, type ReadSlots } from './lab-read-slots.server';

const KEEP_ALIVE_MS = 15_000;

export async function appLabRead(request: Request, store?: KeyStore, slots: ReadSlots = labReadSlots): Promise<Response> {
  const gate = await labGate(request, store, slots.admit);
  return gate instanceof Response ? gate : stream(gate);
}

/** The accepted read's stream. Its admission is released when the read ends, on every path; a reader that goes away stops only the blank lines. */
function stream(gate: AcceptedLab): Response {
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (line: string) => {
        try { controller.enqueue(encoder.encode(line + '\n')); } catch { /* reader gone */ }
      };
      write(JSON.stringify({ accepted: true }));
      keepAlive = setInterval(() => write(''), KEEP_ALIVE_MS);
      // The read runs on when the reader goes away: its budget ends it (AC7c), and
      // it holds its pages until then, so its slots stay taken until it ends.
      void (async () => {
        let last;
        try {
          const res = await labRead(gate);
          last = { status: res.status, body: await res.json() };
        } catch (err) {
          // labRead answers its own failures; anything else is unexpected.
          Sentry.captureException(err);
          last = { status: 500, body: { success: false, error: 'Failed to process request' } };
        } finally {
          gate.release?.();
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
