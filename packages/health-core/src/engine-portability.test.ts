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
const ENGINE_ENTRIES = ['erase.ts', 'record-host.ts', 'record-session.ts', 'storage-self-test.ts'];

const FORBIDDEN: Array<[string, RegExp]> = [
  ['a node: import', /from\s+['"]node:|require\(\s*['"]node:/],
  ['a bare Node built-in', /from\s+['"](fs|path|os|crypto|url|child_process)['"]/],
  ['window', /\bwindow\b/],
  ['document.', /\bdocument\s*\./],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['navigator', /\bnavigator\b/],
  ['crypto.', /\bcrypto\s*\./],
];

/** Globals a module feature-detects (`typeof x !== 'undefined'`), so it runs
 *  where they are missing. */
const GUARDED: Record<string, string[]> = { 'units.ts': ['navigator'] };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Code only: plain string literals (user-facing text) out as well. */
function codeOf(source: string): string {
  return source.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
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
    const source = stripComments(readFileSync(file, 'utf8'));
    // The two import rules read the strings; the globals read code only.
    const found = FORBIDDEN.filter(([, re], i) => re.test(i < 2 ? source : codeOf(source)))
      .map(([what]) => what)
      .filter((what) => !GUARDED[name]?.includes(what));
    expect(found).toEqual([]);
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
      tier: 'device' as const, store, deviceId: () => 'phone', clock: { now: () => Date.parse('2026-10-21T10:00:00.000Z') },
      timers: { set: () => 1, clear: () => {} },
      remoteChanged: () => {}, failureCause: () => 'other', report: () => {}, clearOffFileData: () => {}, clearNamedFiles: () => {},
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
