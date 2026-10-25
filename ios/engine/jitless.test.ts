// The engine bundle never builds a function at runtime: zod runs jitless
// (packages/health-core/src/zod.ts), so its compiled-parser path is dead. The
// bundle runs here as the app runs it, in an empty vm context, with Function trapped.
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleEngine } from '../scripts/build-engine.mjs';
import { parityFixtures } from './fixtures.mjs';

const repo = join(__dirname, '../..');

describe('US-25: the engine bundle runs zod jitless (no new Function)', () => {
  it('plans every parity record without constructing a function', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'engine-')), 'health-engine.js');
    await bundleEngine(out, 1);
    const ctx = vm.createContext({});
    vm.runInContext(`globalThis.made = 0; globalThis.Function = new Proxy(Function, {
      construct(t, a) { globalThis.made++; return Reflect.construct(t, a); },
      apply(t, s, a) { globalThis.made++; return Reflect.apply(t, s, a); } });`, ctx);
    vm.runInContext(readFileSync(out, 'utf8'), ctx);
    const sample = JSON.parse(readFileSync(join(repo, 'docs/examples/health-roadmap.sample.json'), 'utf8'));
    let planned = 0;
    for (const record of Object.values(parityFixtures(sample))) {
      try {
        ctx.HealthEngine.sectionsJson(ctx.HealthEngine.planJson(JSON.stringify(record), '2026-10-21T12:30:00.000Z', 'jitless'));
        planned++;
      } catch { /* a refused record (no height) is still a parse */ }
    }
    expect(planned).toBeGreaterThan(0);
    expect(vm.runInContext('globalThis.__zod_globalConfig.jitless', ctx)).toBe(true);
    expect(vm.runInContext('made', ctx)).toBe(0);
  }, 60_000);
});
