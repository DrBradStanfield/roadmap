/**
 * Test support: run tools/test-chatbot-matching.ts inside the test process (test audit TA-T01).
 *
 * A tsx subprocess costs about 4 s in CI; this costs a fresh module load. It sets the argv the
 * CLI would get, stubs `fetch` (no call leaves the machine, and no real key is ever set),
 * optionally replaces tools/test-queries.json, captures what the harness prints, and turns
 * `process.exit` into a thrown signal so the run stops where the CLI would. Every global it
 * touches is restored afterwards. A handful of real CLI spawns stay in the tests to prove the
 * boundary (argv, exit code, stdout).
 */
import fs from 'node:fs';
import { format } from 'node:util';
import { join } from 'node:path';
import { vi } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const HARNESS = join(REPO_ROOT, 'tools/test-chatbot-matching.ts');

class Exit { constructor(readonly code: number) {} }

export interface HarnessRun { status: number | null; out: string; err: string }

/** Strip ANSI colour codes, as the CLI tests read stdout. */
export const noColour = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export interface HarnessOptions {
  /** The fetch the harness calls. Default: one that throws, so an unexpected call fails loudly. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Replaces tools/test-queries.json. */
  fixtures?: unknown[];
  /** false: no API key at all (the CLI's no-key path). Default: the stub key. */
  key?: boolean;
  /** What process.cwd() reports (the CLI's wrong-folder check). */
  cwd?: string;
}

/** One harness run; `out` and `err` are raw (colours kept), as a subprocess's stdout and stderr. */
export async function runHarness(argv: string[], opts: HarnessOptions = {}): Promise<HarnessRun> {
  let out = '', err = '', status: number | null = null;
  const saved = {
    argv: process.argv, fetch: globalThis.fetch, read: fs.readFileSync, exit: process.exit,
    log: console.log, error: console.error, warn: console.warn,
    stdout: process.stdout.write, stderr: process.stderr.write,
    env: { ...process.env },
  };
  const cwd = opts.cwd ? vi.spyOn(process, 'cwd').mockReturnValue(opts.cwd) : null;
  try {
    process.argv = [process.execPath, HARNESS, ...argv];
    delete process.env.ANTHROPIC_API_KEY; // never a real key: no call leaves the machine
    delete process.env.ANTHROPIC_TEST_API_KEY;
    delete process.env.TOPIC_MASTER_HIDE;
    if (opts.key !== false) process.env.ANTHROPIC_TEST_API_KEY = 'stub';
    globalThis.fetch = (opts.fetch ?? (async (url: string) => { throw new Error(`unexpected fetch ${url}`); })) as typeof fetch;
    if (opts.fixtures) {
      const text = JSON.stringify(opts.fixtures);
      fs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
        String(p).endsWith('tools/test-queries.json') ? text : (saved.read as (...a: unknown[]) => unknown)(p, ...rest)) as typeof fs.readFileSync;
    }
    console.log = (...a: unknown[]) => { out += format(...a) + '\n'; };
    console.error = console.warn = (...a: unknown[]) => { err += format(...a) + '\n'; };
    const writer = (append: (s: string) => void) => ((chunk: unknown, ...rest: unknown[]) => {
      append(String(chunk));
      const cb = rest.find(r => typeof r === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = writer(s => { out += s; });
    process.stderr.write = writer(s => { err += s; });
    process.exit = ((code?: number) => { throw new Exit(code ?? 0); }) as typeof process.exit;
    vi.resetModules();
    await import(HARNESS);
    status = 0; // the CLI always exits through process.exit; reaching here would be a bug the caller sees
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    status = e.code;
  } finally {
    process.argv = saved.argv;
    globalThis.fetch = saved.fetch;
    fs.readFileSync = saved.read;
    process.exit = saved.exit;
    console.log = saved.log; console.error = saved.error; console.warn = saved.warn;
    process.stdout.write = saved.stdout; process.stderr.write = saved.stderr;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    cwd?.mockRestore();
  }
  return { status, out, err };
}

/** A Messages API reply holding `content`, as the stubs answer. */
export function reply(content: unknown[], stopReason = 'end_turn', extra: object = {}): Response {
  return new Response(JSON.stringify({ content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 }, ...extra }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A text-only reply. */
export const textReply = (text: string) => reply([{ type: 'text', text }]);
