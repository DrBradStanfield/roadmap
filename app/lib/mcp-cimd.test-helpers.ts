/**
 * A stand-in for the one `node:https` call the client-metadata fetch makes
 * (US-32 AC47), so a suite can serve a CIMD document with no DNS and no socket.
 * It answers only after the request is ended, as the real one does. A test of
 * the real connection path restores the spy instead.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

export interface StubAnswer {
  status?: number;
  /** Lower-case names, as Node delivers them. `content-type` defaults to JSON. */
  headers?: Record<string, string>;
  body?: string;
  /** 'headers': no response ever arrives. 'body': headers arrive, the body never ends. */
  stall?: 'headers' | 'body';
}

export function stubHttpsRequest(answer: (url: URL) => StubAnswer) {
  return vi.spyOn(https, 'request').mockImplementation(((
    url: URL,
    _options: https.RequestOptions,
    onResponse: (res: IncomingMessage) => void,
  ) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(() => req),
      end: () => {
        const reply = answer(url);
        if (reply.stall === 'headers') return req;
        setImmediate(() => {
          const res = Object.assign(new PassThrough(), {
            statusCode: reply.status ?? 200,
            headers: { 'content-type': 'application/json', ...reply.headers },
          });
          onResponse(res as unknown as IncomingMessage);
          if (reply.stall !== 'body') res.end(reply.body ?? '');
        });
        return req;
      },
    });
    return req;
  }) as unknown as typeof https.request);
}

/** Serve these CIMD documents by URL; anything else answers 404. */
export function serveClientMetadata(documents: Record<string, unknown> = {}) {
  return stubHttpsRequest((url) => (url.href in documents
    ? { body: JSON.stringify(documents[url.href]) }
    : { status: 404, headers: { 'content-type': 'text/plain' }, body: 'no' }));
}
