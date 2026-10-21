/**
 * The record engine runs in three places: the web widget, Node (CLI, MCP) and
 * the iPhone app's JavaScriptCore, which has no DOM and no Node (ios/
 * architecture.md D4). So the engine modules, and every module they import,
 * reference no browser global and import nothing from `node:`. This walks the
 * import graph from each entry and checks the source, comments stripped.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
// Already a root devDependency: ios/scripts/build-engine.mjs bundles with it.
import { build } from 'esbuild';

const SRC = dirname(fileURLToPath(import.meta.url));

/** The modules the web store and the app share. Add each one as it moves. */
const ENGINE_ENTRIES = ['chat-session.ts', 'input-form.ts','state-edits.ts', 'erase.ts', 'live-refresh.ts', 'record-host.ts', 'record-session.ts', 'record-transfer.ts', 'storage-self-test.ts'];

const FORBIDDEN: Array<[string, RegExp]> = [
  ['a node: import', /from\s+['"]node:|require\(\s*['"]node:/],
  ['a bare Node built-in', /from\s+['"](fs|path|os|crypto|url|child_process)['"]/],
  ['window', /\bwindow\b/],
  // The global, not a property of the same name (`parsed.document.title`).
  ['document.', /(?<![.\w])document\s*\./],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['navigator', /\bnavigator\b/],
  // Reaching a global through the global object would get past every name above.
  ['globalThis', /\bglobalThis\b/],
  ['self', /(?<![.\w])self\b/],
  // crypto.randomUUID is the one exception: the iPhone engine supplies it
  // (HealthEngine.swift), for record-edits' fresh row ids (rule 5).
  ['crypto.', /\bcrypto\s*\.(?!randomUUID\b)/],
];

/** Globals a module feature-detects (`typeof x !== 'undefined'`), so it runs
 *  where they are missing. */
const GUARDED: Record<string, string[]> = { 'units.ts': ['navigator'] };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Code only: the text of string and template literals blanked (user-facing
 *  prose, model prompts), the code inside a template's `${...}` kept, so a
 *  quote in a template's prose can never hide the code after it. A small
 *  tokenizer, not a regex: `${}` nests braces, strings and templates. */
function codeOf(source: string): string {
  let out = '';
  let i = 0;
  const quoted = (quote: string) => {
    for (i++; i < source.length && source[i] !== quote && source[i] !== '\n'; i++) if (source[i] === '\\') i++;
    i++;
    out += "''";
  };
  const template = () => {
    for (i++; i < source.length && source[i] !== '`'; ) {
      if (source[i] === '\\') i += 2;
      else if (source[i] === '$' && source[i + 1] === '{') {
        i += 2;
        out += ' ';
        code(true);
        out += ' ';
      } else i++;
    }
    i++;
    out += "''";
  };
  /** Code up to the end, or to the `}` that closes a template's `${`. */
  const code = (inTemplate: boolean) => {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === "'" || c === '"') quoted(c);
      else if (c === '`') template();
      else {
        if (inTemplate && c === '}' && depth-- === 0) {
          i++;
          return;
        }
        if (inTemplate && c === '{') depth++;
        out += c;
        i++;
      }
    }
  };
  code(false);
  return out;
}

/** What `source` reaches that JavaScriptCore lacks. The two import rules
 *  read the strings; the globals read code only. */
function violations(name: string, raw: string): string[] {
  const source = stripComments(raw);
  return FORBIDDEN.filter(([, re], i) => re.test(i < 2 ? source : codeOf(source)))
    .map(([what]) => what)
    .filter((what) => !GUARDED[name]?.includes(what));
}

function reachable(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((e) => join(SRC, e));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const [, spec] of code.matchAll(/(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/g)) {
      queue.push(resolve(dirname(file), spec.endsWith('.ts') ? spec : `${spec}.ts`));
    }
  }
  return [...seen].sort();
}

describe('engine portability (ios/architecture.md D4)', () => {
  const files = reachable(ENGINE_ENTRIES);

  it('reaches the entries and what they import', () => {
    expect(files.map((f) => f.slice(SRC.length + 1))).toEqual(expect.arrayContaining(ENGINE_ENTRIES));
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f]))('%s has no DOM and no Node', (name, file) => {
    expect(violations(name, readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('the scan itself: catches code in a template, globalThis and self, and allows only crypto.randomUUID', () => {
    expect(violations('x.ts', 'const t = `see ${document.title}`;')).toEqual(['document.']);
    expect(violations('x.ts', 'const t = `the document. Return`;')).toEqual([]);
    // A quote in a template's prose must not swallow the code after it.
    expect(violations('x.ts', "const t = `don't ${a}` + window.x;")).toEqual(['window']);
    expect(violations('x.ts', 'const t = `${f({ a: "}" })} and ${`nested ${document.title}`}`;')).toEqual(['document.']);
    expect(violations('x.ts', 'globalThis.fetch(u);')).toEqual(['globalThis']);
    expect(violations('x.ts', 'self.postMessage(m);')).toEqual(['self']);
    expect(violations('x.ts', 'parsed.document.title; row.self;')).toEqual([]);
    expect(violations('x.ts', 'crypto.randomUUID();')).toEqual([]);
    expect(violations('x.ts', 'crypto.subtle.digest(a, b);')).toEqual(['crypto.']);
  });

  // The grep above cannot see a global reached at load (fetch, setTimeout,
  // Blob, TextEncoder, self...). So each entry is bundled the way
  // ios/scripts/build-engine.mjs bundles the engine, and run in an empty vm
  // context: ECMAScript built-ins and nothing else, as in JavaScriptCore.
  it.each(ENGINE_ENTRIES)('%s loads in an empty context, as in JavaScriptCore', async (entry) => {
    const ctx = vm.createContext({});
    vm.runInContext(await bundle(entry), ctx);
    expect(Object.keys((ctx as { Engine: object }).Engine).length).toBeGreaterThan(0);
  });

  it('runs the storage self-test in an empty context', async () => {
    const ctx = vm.createContext({});
    vm.runInContext(await bundle('storage-self-test.ts'), ctx);
    const results = await (ctx as { Engine: { runStorageSelfTest(): Promise<Array<{ pass: boolean }>> } }).Engine.runStorageSelfTest();
    expect(results.length).toBe(3);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it('opens, edits, saves and erases a record session in an empty context, every device need met by the host', async () => {
    const ctx = vm.createContext({});
    vm.runInContext(await bundle(null, "export { RecordSession } from './record-session'; export { MemoryAdapter, MemoryCloud } from './memory-adapter';"), ctx);
    const { RecordSession, MemoryAdapter, MemoryCloud } = (ctx as { Engine: typeof import('./index') }).Engine;
    const store = new MemoryAdapter(new MemoryCloud());
    const host = {
      tier: 'cloud' as const, store, deviceId: () => 'phone', clock: { now: () => Date.parse('2026-10-21T10:00:00.000Z') },
      timers: { set: () => 1, clear: () => {} },
      remoteChanged: () => {}, failureCause: () => 'other', report: () => {}, clearOffFileData: () => {},
      mirror: {
        adapter: new MemoryAdapter(new MemoryCloud()), writesStopped: () => false, wipe: async () => {}, opened: () => {},
        pending: { get: () => false, set: () => {}, clear: () => {} },
      },
    };
    const session = await RecordSession.open(host);
    expect(session.edit((file) => void (file.profile.sex = 'female'))).toBe(true);
    await session.flush();
    expect((await session.erase()).success).toBe(true);
    expect(session.file.meta.eraseEpoch).toBe(1);
  });
});

async function bundle(entry: string | null, contents?: string): Promise<string> {
  const out = await build({
    ...(entry ? { entryPoints: [join(SRC, entry)] } : { stdin: { contents: contents!, resolveDir: SRC, loader: 'ts' as const } }),
    bundle: true,
    format: 'iife',
    globalName: 'Engine',
    target: 'safari17',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent',
  });
  // A type-only module bundles to nothing; give it a name so the check reads it.
  return `${out.outputFiles[0].text}\nif (typeof Engine === 'undefined' || Object.keys(Engine).length === 0) var Engine = { typeOnly: true };`;
}
