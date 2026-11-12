/**
 * US-09 AC2c, AC2h — the chat embed and the blog bubble open no record, so they
 * stay 'loading' for life and only read the mirror. This pins that boundary:
 * a walk of each entry's import graph (static and dynamic) finds no file that
 * calls a device health writer, except the record host's own modules, and no
 * file that opens a record or builds a host (initRoadmapStore, webRecordHost,
 * RoadmapStore.create, ChatHistoryStore.create). If
 * either changes, this fails and its author decides which write state that
 * page takes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url)) + '/..';
const CORE = resolve(SRC, '../../packages/health-core/src');
const STORAGE = resolve(SRC, 'lib/storage.ts');
/** A call to one of lib/storage's device writers, to a hook or helper that writes a shared health key or the
 *  pending marker, a document write, or a device store made. */
const WRITER_CALL = /(?<!function )\b(saveToLocalStorage|patchMirror|keepLpaAsIs|useMatrixDraft|markSyncPending)\s*[<(]|\.writeDocument\s*\(|\bnew\s+LocalStorageAdapter\b/;
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

/** The record host's own modules: they write only inside a host, which only the calls OPENS_A_RECORD names build. */
const HOST_ONLY = ['storage/web-record-host.ts', 'storage/roadmap-store.ts'].map((f) => resolve(SRC, f));
const OPENS_A_RECORD = /(?<!function )\b(initRoadmapStore|webRecordHost|RoadmapStore\.create|ChatHistoryStore\.create)\s*\(/g;
/** The builders' own bodies: each call here runs only inside one of the builders above. A new call in
 *  one of these files changes its count and fails the pin. */
const BUILDER_CALLS = new Map([['lib/roadmap-data.ts', 2], ['storage/roadmap-store.ts', 1], ['storage/chat-history-store.ts', 1]]
  .map(([f, n]) => [resolve(SRC, f as string), n as number]));
const opensARecord = (file: string) => [...readFileSync(file, 'utf8').matchAll(OPENS_A_RECORD)].length !== (BUILDER_CALLS.get(file) ?? 0);

describe('US-09 AC2c: the pages that open no record', () => {
  it.each(['chatbot-embed.tsx', 'site-chat.tsx'])('%s reaches the mirror but calls no device health writer outside the record host', (entry) => {
    const files = reach(entry);
    expect(files.has(STORAGE)).toBe(true); // the walk is real: it reaches the module the writers live in
    const writers = [...files].filter((f) => f !== STORAGE && WRITER_CALL.test(readFileSync(f, 'utf8')));
    expect(writers.sort()).toEqual([...HOST_ONLY].sort());
  });

  it.each(['chatbot-embed.tsx', 'site-chat.tsx'])('%s never opens a record, so the record host\'s writers never run there', (entry) => {
    const files = reach(entry);
    expect([...BUILDER_CALLS.keys()].every((f) => files.has(f))).toBe(true); // the walk reaches the builders' files
    expect([...files].filter(opensARecord)).toEqual([]);
  });

  it('control: the walk finds a writer where there is one (the vitals matrix)', () => {
    const files = [...reach('components/StartingInfoVitals.tsx')];
    expect(files.filter((f) => f !== STORAGE && WRITER_CALL.test(readFileSync(f, 'utf8'))).length).toBeGreaterThan(0);
  });
});
