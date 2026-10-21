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

const SRC = dirname(fileURLToPath(import.meta.url));

/** The modules the web store and the app share. Add each one as it moves. */
const ENGINE_ENTRIES = ['erase.ts'];

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

  it('loads with no browser globals', async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    for (const entry of ENGINE_ENTRIES) await import(`./${entry.replace(/\.ts$/, '')}`);
  });
});
