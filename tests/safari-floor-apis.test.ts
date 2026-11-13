/**
 * US-09 AC41a: shipped code calls no browser API newer than the supported
 * floor unless it feature-detects it first.
 *
 * THE FLOOR IS SAFARI 16.4 (iOS 16.4): US-09 AC41, Brad 2026-11-09. Not
 * Safari 14: AC13g's Safari 14/15 fallbacks predate AC41 and are kept but
 * optional. So `throwIfAborted` (15.4) and `AbortSignal.timeout` (16.0) are
 * fine; `AbortSignal.any` (17.4) is not, and breaks a supported browser.
 *
 * Each entry's Safari version is from MDN browser-compat-data 6.0.0
 * (safari and safari_ios agree for all of these). Scanned: non-test files in
 * the four trees that ship to a browser or the iPhone engine. Comment lines
 * are skipped. Not covered: CSS, dependencies in node_modules, and generic
 * method names this scan cannot tell apart (Set `.union` / `.difference` vs
 * zod's, `.bytes()` vs our own, `.transfer()`).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['packages/health-core/src', 'widget-src/src', 'widget-src/standalone', 'ios/engine'];

/** API, the Safari version that added it, and the one file allowed to use it behind a feature-detect. */
const ABOVE_FLOOR: Array<{ api: string; safari: string; pattern: RegExp; sample: string; allowedIn?: string }> = [
  { api: 'AbortSignal.any', safari: '17.4', pattern: /\bAbortSignal\.any\s*\(/, sample: 'AbortSignal.any([a, b])', allowedIn: 'packages/health-core/src/adapter.ts' },
  { api: 'Promise.withResolvers', safari: '17.4', pattern: /\bPromise\.withResolvers\b|\bP\.withResolvers\s*\(/, sample: 'Promise.withResolvers()', allowedIn: 'widget-src/src/lib/promise-with-resolvers.ts' },
  { api: 'Object.groupBy', safari: '17.4', pattern: /\bObject\.groupBy\s*\(/, sample: 'Object.groupBy(rows, f)' },
  { api: 'Map.groupBy', safari: '17.4', pattern: /\bMap\.groupBy\s*\(/, sample: 'Map.groupBy(rows, f)' },
  { api: 'Element.checkVisibility', safari: '17.4', pattern: /\.checkVisibility\s*\(/, sample: 'el.checkVisibility()' },
  { api: 'Set methods', safari: '17.0', pattern: /\.(symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom|intersection)\s*\(/, sample: 'a.isSubsetOf(b)' },
  { api: 'URL.canParse', safari: '17.0', pattern: /\bURL\.canParse\s*\(/, sample: 'URL.canParse(s)' },
  { api: 'Response.json (static)', safari: '17.0', pattern: /\bResponse\.json\s*\(/, sample: 'Response.json({})' },
  { api: 'URL.parse', safari: '18.0', pattern: /\bURL\.parse\s*\(/, sample: 'URL.parse(s)' },
  { api: 'Document.startViewTransition', safari: '18.0', pattern: /\.startViewTransition\s*\(/, sample: 'document.startViewTransition(f)' },
  { api: 'Promise.try', safari: '18.2', pattern: /\bPromise\.try\s*\(/, sample: 'Promise.try(f)' },
  { api: 'RegExp.escape', safari: '18.2', pattern: /\bRegExp\.escape\s*\(/, sample: 'RegExp.escape(s)' },
  { api: 'Uint8Array base64', safari: '18.2', pattern: /\bUint8Array\.fromBase64\s*\(|\.toBase64\s*\(/, sample: 'Uint8Array.fromBase64(s)' },
  { api: 'Iterator helpers', safari: '18.4', pattern: /\bIterator\.from\s*\(|\.(values|keys|entries)\(\)\.(map|filter|take|drop|flatMap|reduce|toArray|forEach|some|every|find)\s*\(/, sample: 'm.values().map(f)' },
  { api: 'ReadableStream.from', safari: 'none', pattern: /\bReadableStream\.from\s*\(/, sample: 'ReadableStream.from(it)' },
  { api: 'requestIdleCallback', safari: 'none', pattern: /\brequestIdleCallback\s*\(/, sample: 'requestIdleCallback(f)' },
];

const isComment = (line: string) => /^\s*(\/\/|\/?\*)/.test(line);

function shippedFiles(): string[] {
  return execFileSync('git', ['ls-files', ...TREES.flatMap((t) => [`${t}/*.ts`, `${t}/*.tsx`, `${t}/*.js`, `${t}/*.mjs`])], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !/\.(test|spec|pins\.test)\.|\/__tests__\/|\.d\.ts$/.test(f));
}

function hits(): Array<{ file: string; line: number; api: string; safari: string }> {
  const out: Array<{ file: string; line: number; api: string; safari: string }> = [];
  for (const file of shippedFiles()) {
    readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((text, i) => {
      if (isComment(text)) return;
      for (const { api, safari, pattern } of ABOVE_FLOOR) if (pattern.test(text)) out.push({ file, line: i + 1, api, safari });
    });
  }
  return out;
}

describe('US-09 AC41a: no browser API newer than Safari 16.4 (AC41) outside its feature-detect', () => {
  it('every pattern matches its own sample, so none is dead', () => {
    for (const { api, pattern, sample } of ABOVE_FLOOR) expect(pattern.test(sample), api).toBe(true);
  });

  it('shipped code uses none of them, except at its one feature-detecting site', () => {
    const found = hits();
    const unguarded = found
      .filter((h) => ABOVE_FLOOR.find((a) => a.api === h.api)!.allowedIn !== h.file)
      .map((h) => `${h.file}:${h.line} uses ${h.api} (Safari ${h.safari}; floor 16.4, US-09 AC41)`);
    expect(unguarded).toEqual([]);
  });

  it('each allowed site still holds its feature-detect', () => {
    expect(readFileSync(join(ROOT, 'packages/health-core/src/adapter.ts'), 'utf8')).toMatch(/typeof AbortSignal\.any === 'function'\s*\n?\s*\? AbortSignal\.any\(/);
    expect(readFileSync(join(ROOT, 'widget-src/src/lib/promise-with-resolvers.ts'), 'utf8')).toMatch(/if \(typeof P\.withResolvers === 'function'\) return;/);
  });
});
