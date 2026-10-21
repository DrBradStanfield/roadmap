// The web APIs health-core's cloud adapters use (adapter.ts fetchOrFail,
// dropbox-rest.ts, drive-rest.ts), built for JavaScriptCore, which has
// ECMAScript and nothing else (ios/architecture.md D2). Swift supplies five
// primitives (HealthEngine natives): an HTTP request over URLSession, a timer
// on the main queue, and UTF-8 both ways. Everything here is the least the
// adapters touch, not a general polyfill: fetch, Response, Headers, Blob,
// AbortController, AbortSignal (timeout, any), DOMException, setTimeout,
// clearTimeout, TextEncoder and TextDecoder. A global the runtime already has
// is never replaced. Tested in Node (shim.test.ts) and in JavaScriptCore
// (ios/HealthRoadmapTests/ShimTests.swift).

/** What Swift gives the engine. Bodies cross as ArrayBuffers; headers as JSON. */
export interface Natives {
  http(
    method: string, url: string, headers: string, body: ArrayBuffer | null,
    done: (status: number, statusText: string, headers: string, body: ArrayBuffer | null, error: string | null) => void,
  ): number;
  cancelHttp(id: number): void;
  setTimer(ms: number, run: () => void): number;
  clearTimer(id: number): void;
  utf8Encode(text: string): ArrayBuffer;
  utf8Decode(bytes: ArrayBuffer): string;
}

type BodyPart = string | ArrayBuffer | ArrayBufferView | ShimBlob;

/** The exact bytes of a view, as an ArrayBuffer of its own. */
function bufferOf(view: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  // isView, not instanceof ArrayBuffer: a buffer made by the host can come
  // from another realm, where instanceof answers false.
  if (!ArrayBuffer.isView(view)) return view.slice(0);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

let native: Natives;

class ShimDOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message);
    this.name = name;
  }
}

class ShimHeaders {
  private readonly map = new Map<string, string>();
  constructor(init?: ShimHeaders | Record<string, string> | Array<[string, string]>) {
    if (init instanceof ShimHeaders) init.forEach((value, key) => this.set(key, value));
    else if (Array.isArray(init)) for (const [key, value] of init) this.append(key, value);
    else if (init) for (const key of Object.keys(init)) this.set(key, init[key]);
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), String(value));
  }
  append(name: string, value: string): void {
    const had = this.get(name);
    this.set(name, had === null ? value : `${had}, ${value}`);
  }
  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }
  delete(name: string): void {
    this.map.delete(name.toLowerCase());
  }
  forEach(each: (value: string, key: string) => void): void {
    this.map.forEach((value, key) => each(value, key));
  }
  entries(): IterableIterator<[string, string]> {
    return this.map.entries();
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.map.entries();
  }
  toJSON(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

class ShimBlob {
  readonly bytes: Uint8Array;
  readonly type: string;
  constructor(parts: BodyPart[] = [], options: { type?: string } = {}) {
    const chunks = parts.map((part) =>
      part instanceof ShimBlob ? part.bytes
        : typeof part === 'string' ? new Uint8Array(native.utf8Encode(part))
          : new Uint8Array(bufferOf(part)));
    this.bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      this.bytes.set(chunk, at);
      at += chunk.length;
    }
    this.type = options.type ?? '';
  }
  get size(): number {
    return this.bytes.length;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return bufferOf(this.bytes);
  }
  async text(): Promise<string> {
    return native.utf8Decode(bufferOf(this.bytes));
  }
}

class ShimAbortSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: (() => void) | null = null;
  private listeners: Array<() => void> = [];

  addEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: 'abort', listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }
  /** Called by the controller and by `timeout`/`any` only. */
  fire(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    this.onabort?.();
    for (const listener of [...this.listeners]) listener();
  }

  static abort(reason: unknown = new ShimDOMException('This operation was aborted', 'AbortError')): ShimAbortSignal {
    const signal = new ShimAbortSignal();
    signal.fire(reason);
    return signal;
  }
  /** Aborts after `ms` on the native timer, with the TimeoutError browsers use. */
  static timeout(ms: number): ShimAbortSignal {
    const signal = new ShimAbortSignal();
    native.setTimer(ms, () => signal.fire(new ShimDOMException('The operation timed out.', 'TimeoutError')));
    return signal;
  }
  /** Aborts when the first of `signals` does, with its reason. */
  static any(signals: ShimAbortSignal[]): ShimAbortSignal {
    const signal = new ShimAbortSignal();
    for (const each of signals) {
      if (each.aborted) {
        signal.fire(each.reason);
        break;
      }
      each.addEventListener('abort', () => signal.fire(each.reason));
    }
    return signal;
  }
}

class ShimAbortController {
  readonly signal = new ShimAbortSignal();
  abort(reason: unknown = new ShimDOMException('This operation was aborted', 'AbortError')): void {
    this.signal.fire(reason);
  }
}

type ResponseBody = ArrayBuffer | ArrayBufferView | string | ShimBlob | null | undefined;

class ShimResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ShimHeaders;
  private readonly body: ArrayBuffer;

  constructor(body?: ResponseBody, init: { status?: number; statusText?: string; headers?: ShimHeaders | Record<string, string> } = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.headers = new ShimHeaders(init.headers);
    this.body = body == null ? new ArrayBuffer(0) : new ShimBlob([body]).bytes.buffer as ArrayBuffer;
  }
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.body.slice(0);
  }
  async text(): Promise<string> {
    return native.utf8Decode(this.body.slice(0));
  }
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

interface FetchInit {
  method?: string;
  headers?: ShimHeaders | Record<string, string>;
  body?: ResponseBody;
  signal?: ShimAbortSignal;
}

/** fetch over the native request. Rejects with a TypeError on a network
 *  failure (as browsers do, so fetchOrFail's catch reads it as "did not
 *  answer"), and with the signal's reason on an abort, which also cancels
 *  the native request. */
function shimFetch(url: string | { toString(): string }, init: FetchInit = {}): Promise<ShimResponse> {
  const { signal } = init;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const body = init.body == null ? null : bufferOf(new ShimBlob([init.body]).bytes);
    const headers = JSON.stringify(new ShimHeaders(init.headers).toJSON());
    const onAbort = () => {
      if (settled) return;
      settled = true;
      native.cancelHttp(id);
      reject(signal!.reason);
    };
    const id = native.http((init.method ?? 'GET').toUpperCase(), String(url), headers, body, (status, statusText, answerHeaders, answer, error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error !== null) reject(new TypeError(error));
      else resolve(new ShimResponse(answer, { status, statusText, headers: JSON.parse(answerHeaders) as Record<string, string> }));
    });
    signal?.addEventListener('abort', onAbort);
  });
}

class ShimTextEncoder {
  readonly encoding = 'utf-8';
  encode(text = ''): Uint8Array {
    return new Uint8Array(native.utf8Encode(text));
  }
}

class ShimTextDecoder {
  readonly encoding = 'utf-8';
  decode(bytes?: ArrayBuffer | ArrayBufferView): string {
    return bytes == null ? '' : native.utf8Decode(bufferOf(bytes));
  }
}

/** Put each missing API on `target` (the engine's global object). */
export function installShim(target: Record<string, unknown>, natives: Natives): void {
  native = natives;
  const apis: Record<string, unknown> = {
    fetch: shimFetch,
    Response: ShimResponse,
    Headers: ShimHeaders,
    Blob: ShimBlob,
    AbortController: ShimAbortController,
    AbortSignal: ShimAbortSignal,
    DOMException: ShimDOMException,
    TextEncoder: ShimTextEncoder,
    TextDecoder: ShimTextDecoder,
    setTimeout: (run: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => native.setTimer(Number(ms) || 0, () => run(...args)),
    clearTimeout: (id: unknown) => {
      if (typeof id === 'number') native.clearTimer(id);
    },
  };
  for (const [name, api] of Object.entries(apis)) {
    if (typeof target[name] === 'undefined') target[name] = api;
  }
}
