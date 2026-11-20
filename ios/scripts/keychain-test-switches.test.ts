// US-25 AC11q: the Keychain test switches (`TokenStore.failsSaves`, `failsDeletes`) and a settable
// `OAuthClient.tokens` exist only in Debug builds, so app code in a Release build cannot switch them on.
// The Release build is the real check: it does not compile a use of them. CI builds Debug only, so this
// test keeps the `#if DEBUG` fences in place. Limits: line-based; it reads `#if`, `#else` and `#endif`
// lines, not every way Swift can spell a condition.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const APP = join(__dirname, '..', 'HealthRoadmap');
const SWITCHES = /\bfails(?:Saves|Deletes)\b/;

/** For each line: 'debug' inside an `#if DEBUG` branch, 'release' inside its `#else`, else 'both'. */
const buildOf = (text: string) => {
  const open: { debug: boolean; inElse: boolean }[] = [];
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (/^#if\b/.test(t)) open.push({ debug: /^#if\s+DEBUG\s*$/.test(t), inElse: false });
    else if (/^#else\b/.test(t) && open.length) open[open.length - 1].inElse = true;
    else if (/^#endif\b/.test(t)) open.pop();
    const fence = [...open].reverse().find((f) => f.debug);
    return { line: t, build: fence ? (fence.inElse ? 'release' : 'debug') : 'both' };
  });
};

const read = (f: string) => buildOf(readFileSync(join(APP, f), 'utf8'));
const swiftFiles = () => (readdirSync(APP, { recursive: true }) as string[]).filter((f) => f.endsWith('.swift'));

it('the Keychain failure switches are compiled in Debug builds only', () => {
  const uses = swiftFiles().flatMap((f) => read(f).filter((l) => SWITCHES.test(l.line)).map((l) => ({ f, ...l })));
  expect(uses.filter((u) => u.f === 'Sync/TokenStore.swift').length, 'two declarations and two guards').toBe(4);
  expect(uses.filter((u) => u.build !== 'debug')).toEqual([]);
});

it("OAuthClient's tokens are settable in Debug builds only, and private in Release", () => {
  const lines = read('Sync/OAuthClient.swift');
  const decl = (build: string) => lines.filter((l) => l.build === build && /\btokens: TokenStore$/.test(l.line)).map((l) => l.line);
  expect(decl('debug')).toEqual(['var tokens: TokenStore']);
  expect(decl('release')).toEqual(['private let tokens: TokenStore']);
  expect(decl('both')).toEqual([]);
});

it('reads the fences it relies on', () => {
  const b = buildOf('a\n#if DEBUG\nb\n#if targetEnvironment(simulator)\nc\n#endif\n#else\nd\n#endif\ne');
  expect(b.map((l) => l.build)).toEqual(['both', 'debug', 'debug', 'debug', 'debug', 'debug', 'release', 'release', 'both', 'both']);
});
