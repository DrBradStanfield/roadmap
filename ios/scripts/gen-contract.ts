// Writes the bridge's JSON pair from ios/engine/contract.ts (I-2):
//   npx tsx ios/scripts/gen-contract.ts
// contract.test.ts fails in CI when a checked-in file differs from what this writes.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeContractJson, bridgeOptionalJson } from '../engine/contract-json';

const engine = join(dirname(fileURLToPath(import.meta.url)), '../engine');
writeFileSync(join(engine, 'bridge-contract.json'), bridgeContractJson());
writeFileSync(join(engine, 'bridge-optional.json'), bridgeOptionalJson());
console.log('wrote bridge-contract.json and bridge-optional.json from contract.ts');
