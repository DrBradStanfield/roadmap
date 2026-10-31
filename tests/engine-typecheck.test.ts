/**
 * The iPhone engine (ios/engine/*.ts) is the bundle the app runs and the one
 * shipped over the air. esbuild (ios/scripts/build-engine.mjs) and vitest strip
 * types without checking them, and none of CI's tsc projects (widget-src,
 * health-core, tsconfig.server.json) includes ios/engine, so a type error there
 * reached the phone unseen. Housekeeping (no user-facing behaviour): this pins
 * the CI step and that its project covers every engine file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('CI type-checks the iPhone engine', () => {
  it('package.json typecheck:engine runs tsc on tsconfig.engine.json', () => {
    expect(pkg.scripts['typecheck:engine']).toBe('tsc --noEmit -p tsconfig.engine.json');
  });

  it('ci.yml runs typecheck:engine', () => {
    expect(ci.some((l) => /^\s*- run: npm run typecheck:engine\s*$/.test(l))).toBe(true);
  });

  it('tsconfig.engine.json covers every ios/engine .ts file', () => {
    const file = join(ROOT, 'tsconfig.engine.json');
    const read = ts.readConfigFile(file, ts.sys.readFile);
    expect(read.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, file);
    expect(parsed.errors).toEqual([]);
    const covered = new Set(parsed.fileNames.map((f) => resolve(f)));
    const engine = readdirSync(join(ROOT, 'ios/engine')).filter((f) => f.endsWith('.ts'));
    expect(engine).toContain('entry.ts');
    for (const f of engine) expect(covered.has(join(ROOT, 'ios/engine', f)), f).toBe(true);
  });
});
