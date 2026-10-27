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
import { createEmptyFile, createMeasurement } from '../../packages/health-core/src/roadmap-file';

const repo = join(__dirname, '../..');

describe('US-25: the engine bundle runs zod jitless (no new Function)', () => {
  it('US-10 AC8a: bundled metadata recovery preserves deletions through warm and cold readers', async () => {
    const early = '2026-09-03T00:00:00.000Z', late = '2026-10-26T00:00:00.000Z';
    const out = join(mkdtempSync(join(tmpdir(), 'engine-')), 'health-engine.js');
    await bundleEngine(out, 1);
    const code = readFileSync(out, 'utf8');
    const live = createEmptyFile({ deviceId: 'synthetic', now: '2026-08-01T00:00:00.000Z' });
    live.meta.createdAt = '2026-99-01T00:00:00Z';
    live.measurements = [createMeasurement({ id: 'synthetic-row', metricType: 'weight', value: 70,
      recordedAt: '2026-07-01', createdAt: '2026-09-15T00:00:00.000Z' })];
    live.labValues = [{ id: 'synthetic-lab', metricName: 'ferritin', value: 85, unit: 'µg/L',
      referenceLow: null, referenceHigh: null, recordedAt: '2026-07-01', createdAt: '2026-09-15T00:00:00.000Z',
      source: 'manual', status: 'active', correctsId: null }];
    const dead = { ...live, meta: { ...live.meta, createdAt: late, updatedAt: late },
      measurements: live.measurements.map((r) => ({ ...r, status: 'entered-in-error' })),
      labValues: live.labValues.map((r) => ({ ...r, status: 'entered-in-error' })) };
    for (const updatedAt of [live.meta.updatedAt, 'broken']) {
      const text = JSON.stringify({ ...live, meta: { ...live.meta, updatedAt } });
      const deleted = JSON.stringify(dead);
      for (const warmAt of [null, early, late]) {
        const ctx = vm.createContext({});
        vm.runInContext('globalThis.Function = function () { throw new Error("no dynamic functions"); }', ctx);
        vm.runInContext(code, ctx);
        if (warmAt) ctx.HealthEngine.historyJson(text, 'weight', warmAt, 'synthetic');
        for (const [a, b] of [[text, deleted], [deleted, text]]) {
          const merged = JSON.parse(ctx.HealthEngine.mergeJson(a, b, late, 'synthetic'));
          expect(merged.measurements).toEqual(dead.measurements);
          expect(merged.labValues).toEqual(dead.labValues);
        }
      }
    }
  }, 60_000);

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
