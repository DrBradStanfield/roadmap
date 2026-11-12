/**
 * US-09 AC2c, AC2h — the chat embed and the blog bubble open no record, so they
 * stay 'loading' for life and only read the mirror. This pins that boundary:
 * a walk of each entry's import graph (static and dynamic) finds no file that
 * calls a device health writer. If one ever does, this fails and its author
 * decides which write state that page takes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url)) + '/..';
const CORE = resolve(SRC, '../../packages/health-core/src');
const STORAGE = resolve(SRC, 'lib/storage.ts');
/** A call to one of lib/storage's device writers, or to a hook or helper that writes a shared health key. */
const WRITER_CALL = /(?<!function )\b(saveToLocalStorage|patchMirror|keepLpaAsIs|useMatrixDraft)\s*[<(]/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every source file the entry reaches. Bare packages and assets are left out. */
function reach(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(SRC, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const base = spec.startsWith('.') ? resolve(dirname(file), spec)
        : spec.startsWith('@roadmap/health-core/') ? resolve(CORE, spec.slice('@roadmap/health-core/'.length)) : null;
      const next = base && resolveFile(base);
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe('US-09 AC2c: the pages that open no record', () => {
  it.each(['chatbot-embed.tsx', 'site-chat.tsx'])('%s reaches the mirror but calls no device health writer', (entry) => {
    const files = reach(entry);
    expect(files.has(STORAGE)).toBe(true); // the walk is real: it reaches the module the writers live in
    const writers = [...files].filter((f) => f !== STORAGE && WRITER_CALL.test(readFileSync(f, 'utf8')));
    expect(writers).toEqual([]);
  });

  it('control: the walk finds a writer where there is one (the vitals matrix)', () => {
    const files = [...reach('components/StartingInfoVitals.tsx')];
    expect(files.filter((f) => f !== STORAGE && WRITER_CALL.test(readFileSync(f, 'utf8'))).length).toBeGreaterThan(0);
  });
});
