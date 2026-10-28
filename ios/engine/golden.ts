// Runs the engine from SOURCE (not the bundle) and prints the golden for one
// record: the plan or its error, and the layout (US-25 AC1).
//   tsx ios/engine/golden.ts <record.json> <nowIso> <deviceId>
import { readFileSync } from 'node:fs';
import { planJson, sectionsJson } from './entry';

const [recordPath, now, device] = process.argv.slice(2);
let result: { plan: string | null; error: string | null; sections: string | null };
try {
  const plan = planJson(readFileSync(recordPath, 'utf8'), now, device);
  result = { plan, error: null, sections: sectionsJson(plan) };
} catch (error) {
  // String(error) is what JavaScriptCore's exception.toString() gives the app.
  result = { plan: null, error: String(error), sections: null };
}
process.stdout.write(JSON.stringify(result));
