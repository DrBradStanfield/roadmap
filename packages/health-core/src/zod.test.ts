import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from './zod';
import { addMeasurementInput } from './mcp-tools';

const repo = new URL('../../..', import.meta.url).pathname;

describe('zod runs jitless: no dependency code calls new Function (CLAUDE.md security rule)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is configured before any schema is built', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('parses an object schema without building a function, and still parses it right', () => {
    const made = vi.spyOn(globalThis, 'Function');
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
    for (let i = 0; i < 50; i++) expect(schema.safeParse({ a: 'x', b: { c: i } }).success).toBe(true);
    expect(schema.safeParse({ a: 'x', b: { c: 'no' } }).success).toBe(false);
    expect(addMeasurementInput.safeParse({ metricType: 'weight', value: 80, recordedAt: '2026-01-01' }).success).toBe(true);
    expect(made).not.toHaveBeenCalled();
  });

  it('every module that builds a schema takes z from ./zod, never from zod itself', () => {
    // import, export-from, require() and import(), of zod or a subpath, in any source a bundle or the server runs.
    const reachesZod = `(from|require\\(|import\\()[[:space:]]*['"]zod(/[^'"]*)?['"]`;
    const sources = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'];
    const hits = execFileSync('git', ['grep', '--untracked', '-lE', reachesZod, '--', ...sources, ':!docs'], { cwd: repo })
      .toString().trim().split('\n');
    expect(hits).toEqual(['packages/health-core/src/zod.ts']);
  });
});
