// US-25 AC11: the web APIs health-core's cloud adapters need, built for
// JavaScriptCore over the natives Swift supplies (shim.ts). Run here in an
// empty vm context, which like JavaScriptCore has ECMAScript and nothing else,
// with a fake native standing in for URLSession and the main queue.
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

interface Sent { method: string; url: string; headers: Record<string, string>; body: string | null; id: number }

/** A fake of the Swift natives: requests are recorded and answered by the test;
 *  timers run when the test says. */
function fakeNative() {
  const sent: Sent[] = [];
  const answers = new Map<number, (status: number, statusText: string, headers: string, body: ArrayBuffer | null, error: string | null) => void>();
  const cancelled: number[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const encode = (text: string) => new Uint8Array(Buffer.from(text, 'utf8')).buffer;
  const decode = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString('utf8');
  const native = {
    http(method: string, url: string, headers: string, body: ArrayBuffer | null, done: never) {
      const id = next++;
      sent.push({ method, url, headers: JSON.parse(headers), body: body ? decode(body) : null, id });
      answers.set(id, done);
      return id;
    },
    cancelHttp(id: number) {
      cancelled.push(id);
    },
    setTimer(_ms: number, run: () => void) {
      const id = next++;
      timers.set(id, run);
      return id;
    },
    clearTimer(id: number) {
      timers.delete(id);
    },
    utf8Encode: encode,
    utf8Decode: decode,
  };
  const answer = (id: number, status: number, body: string | null, headers: Record<string, string> = {}) =>
    answers.get(id)!(status, status === 200 ? 'OK' : 'Conflict', JSON.stringify(headers), body == null ? null : encode(body), null);
  const fail = (id: number, error: string) => answers.get(id)!(0, '', '{}', null, error);
  const runTimers = () => {
    const due = [...timers.entries()];
    timers.clear();
    for (const [, run] of due) run();
  };
  return { native, sent, answer, fail, cancelled, timers, runTimers };
}

async function shimmed() {
  const out = await build({
    stdin: { contents: "export { installShim } from './shim';", resolveDir: here, loader: 'ts' },
    bundle: true, format: 'iife', globalName: 'Shim', target: 'safari17', platform: 'neutral', write: false, logLevel: 'silent',
  });
  const ctx = vm.createContext({});
  vm.runInContext(out.outputFiles[0].text, ctx);
  const fake = fakeNative();
  (ctx as { Shim: { installShim(g: object, n: object): void } }).Shim.installShim(ctx, fake.native);
  const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
  return { ctx: ctx as Record<string, unknown>, fake, run };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('the JavaScriptCore shim (US-25 AC11)', () => {
  it('fetch sends the method, headers and body, and reads the answer as text, JSON and headers', async () => {
    const { fake, run } = await shimmed();
    const pending = run<Promise<unknown>>(`
      fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST', headers: { Authorization: 'Bearer t', 'Dropbox-API-Arg': '{"path":"/a"}' }, body: '{"é":1}',
      }).then(async (res) => [res.ok, res.status, res.headers.get('Dropbox-API-Result'), await res.json()])`);
    expect(fake.sent[0]).toMatchObject({ method: 'POST', url: 'https://content.dropboxapi.com/2/files/upload', body: '{"é":1}' });
    expect(fake.sent[0].headers).toEqual({ authorization: 'Bearer t', 'dropbox-api-arg': '{"path":"/a"}' });
    fake.answer(fake.sent[0].id, 200, '{"rev":"r2"}', { 'Dropbox-API-Result': '{"rev":"r1"}' });
    expect(await pending).toEqual([true, 200, '{"rev":"r1"}', { rev: 'r2' }]);
  });

  it('a Response can be rebuilt from its own bytes, as fetchOrFail does; a 409 is not ok', async () => {
    const { fake, run } = await shimmed();
    const pending = run<Promise<unknown>>(`
      fetch('https://x/y').then(async (res) => {
        const bytes = await res.arrayBuffer();
        const again = new Response(bytes.byteLength ? bytes : null, { status: res.status, statusText: res.statusText, headers: res.headers });
        return [again.ok, again.status, again.headers.get('x-a'), await again.text()];
      })`);
    fake.answer(fake.sent[0].id, 409, 'path/conflict', { 'X-A': 'b' });
    expect(await pending).toEqual([false, 409, 'b', 'path/conflict']);
    expect(await run<Promise<string>>("new Response(null, { status: 204 }).text()")).toBe('');
  });

  it('a Blob of strings and bytes is sent whole, with its size (the Drive multipart upload)', async () => {
    const { fake, run } = await shimmed();
    run(`fetch('https://x/upload', { method: 'POST', body: new Blob(['--b\\r\\n', '{"é":1}', new Uint8Array([33])]) })`);
    expect(fake.sent[0].body).toBe('--b\r\n{"é":1}!');
    expect(run('new Blob(["é"]).size')).toBe(2);
  });

  it('a network failure rejects with a TypeError, as browsers do', async () => {
    const { fake, run } = await shimmed();
    const pending = run<Promise<unknown>>("fetch('https://x').then(() => 'ok', (e) => [e instanceof TypeError, e.message])");
    fake.fail(fake.sent[0].id, 'The Internet connection appears to be offline.');
    expect(await pending).toEqual([true, 'The Internet connection appears to be offline.']);
  });

  it('an abort cancels the request and rejects with an AbortError; an aborted signal never sends', async () => {
    const { fake, run } = await shimmed();
    const pending = run<Promise<unknown>>(`
      globalThis.c = new AbortController();
      fetch('https://x', { signal: c.signal }).then(() => 'ok', (e) => [e.name, e instanceof DOMException])`);
    run('c.abort()');
    expect(await pending).toEqual(['AbortError', true]);
    expect(fake.cancelled).toEqual([fake.sent[0].id]);
    // An answer arriving after the abort is ignored.
    fake.answer(fake.sent[0].id, 200, 'late');
    const early = run<Promise<unknown>>("fetch('https://x', { signal: c.signal }).then(() => 'ok', (e) => e.name)");
    expect(await early).toBe('AbortError');
    expect(fake.sent).toHaveLength(1);
  });

  it('AbortSignal.timeout aborts with a TimeoutError on the native timer, and AbortSignal.any follows either', async () => {
    const { fake, run } = await shimmed();
    run(`globalThis.t = AbortSignal.timeout(30000); globalThis.c = new AbortController(); globalThis.both = AbortSignal.any([c.signal, t]);`);
    expect(run('[t.aborted, both.aborted]')).toEqual([false, false]);
    fake.runTimers();
    expect(run('[t.aborted, t.reason.name, both.aborted, both.reason.name]')).toEqual([true, 'TimeoutError', true, 'TimeoutError']);
  });

  it('setTimeout runs on the native timer with its arguments, and clearTimeout stops it', async () => {
    const { fake, run } = await shimmed();
    run('globalThis.seen = []; setTimeout((a) => seen.push(a), 10, "first"); const k = setTimeout(() => seen.push("no"), 10); clearTimeout(k);');
    fake.runTimers();
    expect(run('seen')).toEqual(['first']);
  });

  it('TextEncoder and TextDecoder round-trip UTF-8 through the natives', async () => {
    const { run } = await shimmed();
    expect(run('Array.from(new TextEncoder().encode("é"))')).toEqual([195, 169]);
    expect(run('new TextDecoder().decode(new TextEncoder().encode("µmol/L ✓"))')).toBe('µmol/L ✓');
  });

  it('never replaces a global the runtime already has', async () => {
    const out = await build({
      stdin: { contents: "export { installShim } from './shim';", resolveDir: here, loader: 'ts' },
      bundle: true, format: 'iife', globalName: 'Shim', target: 'safari17', platform: 'neutral', write: false, logLevel: 'silent',
    });
    const own = () => 'own';
    const ctx = vm.createContext({ fetch: own });
    vm.runInContext(out.outputFiles[0].text, ctx);
    (ctx as { Shim: { installShim(g: object, n: object): void } }).Shim.installShim(ctx, fakeNative().native);
    expect((ctx as { fetch: unknown }).fetch).toBe(own);
    await tick();
  });
});
