/**
 * Every package a file imports is declared in the manifest that owns the file
 * (widget-src/, packages/health-core/, or the root for everything else).
 * Several were not: a production route imported `@sentry/node`, a tool `pg`,
 * and 300+ test files `vitest` or `@testing-library/react`, all reaching
 * node_modules only as some other package's dependency. One upgrade that drops
 * them breaks the import with no manifest change to review. Housekeeping (no
 * user-facing behaviour).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Resolved to its source by the vitest, vite and tsconfig aliases, never from node_modules.
const ALIASES = new Set(['@roadmap/health-core']);
const WORKSPACES = ['widget-src/', 'packages/health-core/', ''];

function declared(dir: string): Set<string> {
  const m = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  return new Set(Object.keys({ ...m.dependencies, ...m.devDependencies, ...m.peerDependencies }));
}

function undeclaredImports(): string[] {
  const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.mjs', '*.js', '*.cjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !/^(extensions|demo-video|docs)\//.test(f));
  const manifests = new Map(WORKSPACES.map((w) => [w, declared(w)]));
  const missing = new Set<string>();
  for (const f of files) {
    const owner = WORKSPACES.find((w) => f.startsWith(w))!;
    for (const { fileName: spec } of ts.preProcessFile(readFileSync(join(ROOT, f), 'utf8'), true, true).importedFiles) {
      if (/^(\.|\/|node:|~\/|virtual:|\+)/.test(spec)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (builtinModules.includes(name) || ALIASES.has(name)) continue;
      if (!manifests.get(owner)!.has(name)) missing.add(`${owner || './'}package.json lacks ${name} (${f})`);
    }
  }
  return [...missing].sort();
}

describe('declared dependencies', () => {
  it('every imported package is declared where it is imported', () => {
    const missing = undeclaredImports();
    // One line per package and manifest is enough to act on.
    const byPackage = [...new Map(missing.map((l) => [l.replace(/ \(.*$/, ''), l])).values()];
    expect(byPackage).toEqual([]);
  });
});
