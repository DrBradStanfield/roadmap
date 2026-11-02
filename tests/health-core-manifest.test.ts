/**
 * packages/health-core/package.json pointed `main`, `module` and `types` at a
 * gitignored `dist/` that only a manual `tsup` run creates, and nothing loads
 * it: the widget and vitest alias the name to `src`, the server path-maps it,
 * and app, tools and ios import `src` by relative path. The one reader was the
 * TypeScript checker under the root tsconfig (editors, `npx tsc`), which then
 * found no types at all, or stale ones from an old build (docs/reference.md
 * recorded the trap). Housekeeping (no user-facing behaviour): the manifest
 * points at the source, and the unused build is gone.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages/health-core');
const manifest = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'));

// What the type checker finds for the package name under the root tsconfig.
function resolveUnderRootTsconfig(spec: string): string | undefined {
  const config = ts.getParsedCommandLineOfConfigFile(join(ROOT, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)); },
  })!;
  const from = join(ROOT, 'app/root.tsx');
  const r = ts.resolveModuleName(spec, from, config.options, ts.sys).resolvedModule;
  return r && relative(ROOT, r.resolvedFileName);
}

describe('health-core package manifest', () => {
  it('every entry field names a tracked source file, not a build output', () => {
    for (const field of ['main', 'module', 'types']) {
      if (manifest[field] === undefined) continue;
      expect(manifest[field], field).not.toMatch(/^dist\//);
      expect(existsSync(join(CORE, manifest[field])), `${field}: ${manifest[field]}`).toBe(true);
    }
  });

  it('the root tsconfig resolves @roadmap/health-core to its source', () => {
    expect(resolveUnderRootTsconfig('@roadmap/health-core')).toBe('packages/health-core/src/index.ts');
  });

  it('keeps no build script for the dist nothing reads', () => {
    expect(manifest.scripts?.build).toBeUndefined();
    expect(manifest.scripts?.dev).toBeUndefined();
    expect(manifest.devDependencies?.tsup).toBeUndefined();
    expect(manifest.scripts?.test).toBe('vitest run');
  });
});
