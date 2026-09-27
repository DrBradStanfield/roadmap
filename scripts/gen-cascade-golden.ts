/**
 * Writes packages/health-core/src/medication-cascades.golden.json from one
 * version's calculateHealthResults. How and when to run it:
 * packages/health-core/src/medication-cascades.golden.ts.
 *
 *   npx tsx scripts/gen-cascade-golden.ts <path to calculations.ts> <commit>
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { goldenRecord, type CalculateHealthResults } from '../packages/health-core/src/medication-cascades.golden';

const [calculationsPath, source] = process.argv.slice(2);
if (!calculationsPath || !source) {
  console.error('usage: npx tsx scripts/gen-cascade-golden.ts <path to calculations.ts> <commit>');
  process.exit(1);
}
const { calculateHealthResults } = await import(pathToFileURL(resolve(calculationsPath)).href) as { calculateHealthResults: CalculateHealthResults };
const out = fileURLToPath(new URL('../packages/health-core/src/medication-cascades.golden.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(goldenRecord(calculateHealthResults, source), null, 1)}\n`);
console.log(`wrote ${out}`);
