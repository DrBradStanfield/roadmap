/**
 * The storage self-test passes in the engine's own runtime. The GitHub Pages
 * harness runs it in the browser; the iPhone app will run it on bundle load
 * and drop a bundle that fails (ios/architecture.md D3).
 */
import { expect, it } from 'vitest';
import { runStorageSelfTest } from './storage-self-test';

it('passes every check, twice in a row (its clock resets)', async () => {
  for (let run = 0; run < 2; run++) {
    const results = await runStorageSelfTest();
    expect(results).toHaveLength(3);
    expect(results.filter((r) => !r.pass)).toEqual([]);
  }
});
