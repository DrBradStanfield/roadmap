/**
 * US-09 AC2c, AC2h — the chat embed and the blog bubble open no record, so they
 * stay 'loading' for life and only read the mirror. This pins that boundary:
 * a walk of each entry's import graph (static and dynamic) finds no file that
 * calls a device health writer, except the record host's own modules, and no
 * file that opens a record or builds a host (initRoadmapStore, webRecordHost,
 * RoadmapStore.create, ChatHistoryStore.create) outside a builder's own body
 * (found by enclosing function with the TypeScript parser). If either changes, this fails and its author decides which write state that
 * page takes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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

/** The record host's own modules: they write only inside a host, which only the BUILDERS calls build. */
const HOST_ONLY = ['storage/web-record-host.ts', 'storage/roadmap-store.ts'].map((f) => resolve(SRC, f));
/** The calls that open a record or build a host. */
const BUILDERS = new Set(['initRoadmapStore', 'webRecordHost', 'RoadmapStore.create', 'ChatHistoryStore.create']);
/** The files that hold the builders' own bodies, where the exempt calls live. */
const BUILDER_FILES = ['lib/roadmap-data.ts', 'storage/roadmap-store.ts', 'storage/chat-history-store.ts'].map((f) => resolve(SRC, f));

/** `X.m` for a property access, `f` for a plain name, else null. */
function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return `${e.expression.text}.${e.name.text}`;
  return null;
}

/** The name a function is known by: `f` for a declaration or `const f = () => …`, `X.m` for a class method or
 *  an object property `const X = { m: () => … }`. */
function functionName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name) && ts.isClassDeclaration(fn.parent) && fn.parent.name) return `${fn.parent.name.text}.${fn.name.text}`;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  const at = fn.parent;
  if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
  if (ts.isPropertyAssignment(at) && ts.isIdentifier(at.name) && ts.isObjectLiteralExpression(at.parent)
    && ts.isVariableDeclaration(at.parent.parent) && ts.isIdentifier(at.parent.parent.name)) return `${at.parent.parent.name.text}.${at.name.text}`;
  return null;
}

/** Every builder call in the file, as `name` (inside a builder's own body, so it runs only when that builder
 *  runs) or `line name` (anywhere else: that call opens a record). Comments and strings never match. */
function builderCalls(file: string): { exempt: string[]; opens: string[] } {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = { exempt: [] as string[], opens: [] as string[] };
  const visit = (node: ts.Node, inBuilder: boolean): void => {
    const name = ts.isCallExpression(node) ? calleeName(node.expression) : null;
    if (name && BUILDERS.has(name)) {
      if (inBuilder) found.exempt.push(name);
      else found.opens.push(`${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${name}`);
    }
    const own = functionName(node);
    node.forEachChild((child) => visit(child, inBuilder || (own !== null && BUILDERS.has(own))));
  };
  visit(source, false);
  return found;
}

describe('US-09 AC2c: the pages that open no record', () => {
  it.each(['chatbot-embed.tsx', 'site-chat.tsx'])('%s reaches the mirror but calls no device health writer outside the record host', (entry) => {
    const files = reach(entry);
    expect(files.has(STORAGE)).toBe(true); // the walk is real: it reaches the module the writers live in
    const writers = [...files].filter((f) => f !== STORAGE && WRITER_CALL.test(readFileSync(f, 'utf8')));
    expect(writers.sort()).toEqual([...HOST_ONLY].sort());
  });

  it.each(['chatbot-embed.tsx', 'site-chat.tsx'])('%s never opens a record, so the record host\'s writers never run there', (entry) => {
    const files = reach(entry);
    expect(BUILDER_FILES.every((f) => files.has(f))).toBe(true); // the walk reaches the builders' files
    const opens = [...files].flatMap((f) => builderCalls(f).opens.map((at) => `${relative(SRC, f)}:${at}`));
    expect(opens).toEqual([]);
    // The parser is real: it finds the builders' own calls and exempts each by its enclosing builder.
    expect(BUILDER_FILES.flatMap((f) => builderCalls(f).exempt).sort())
      .toEqual(['ChatHistoryStore.create', 'RoadmapStore.create', 'webRecordHost', 'webRecordHost']);
  });

  it('control: the walk finds a writer where there is one (the vitals matrix)', () => {
    const files = [...reach('components/StartingInfoVitals.tsx')];
    expect(files.filter((f) => f !== STORAGE && WRITER_CALL.test(readFileSync(f, 'utf8'))).length).toBeGreaterThan(0);
  });
});
