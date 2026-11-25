// Writes every file generated from ios/engine/contract.ts (I-2):
//   npx tsx ios/scripts/gen-contract.ts
// the JSON pair (bridge-contract.json, hashed for the bridge id, and bridge-optional.json), the
// neutral contract.schema.json, and the app's Swift in HealthRoadmap/Engine/Generated/.
// contract.test.ts and contract-drift.test.ts fail in CI when a checked-in file differs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedFiles } from '../engine/contract-swift';

const ios = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const [path, text] of Object.entries(generatedFiles())) {
  mkdirSync(dirname(join(ios, path)), { recursive: true });
  writeFileSync(join(ios, path), text);
}
console.log(`wrote ${Object.keys(generatedFiles()).join(', ')} from contract.ts`);
