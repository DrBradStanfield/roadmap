// Runs the engine from SOURCE (not the bundle) and prints the goldens for a list of
// records, as one JSON map of name → result: the plan or its error, and the layout (US-25 AC1).
//   tsx ios/engine/golden.ts <nowIso> <deviceId> <name> <record.json> [<name> <record.json> ...]
import { readFileSync } from 'node:fs';
import { planJson, sectionsJson } from './entry';

type Result = { plan: string | null; error: string | null; sections: string | null };
const [now, device, ...pairs] = process.argv.slice(2);
const results: Record<string, Result> = {};
for (let i = 0; i < pairs.length; i += 2) {
  try {
    const plan = planJson(readFileSync(pairs[i + 1], 'utf8'), now, device);
    results[pairs[i]] = { plan, error: null, sections: sectionsJson(plan) };
  } catch (error) {
    // String(error) is what JavaScriptCore's exception.toString() gives the app.
    results[pairs[i]] = { plan: null, error: String(error), sections: null };
  }
}
process.stdout.write(JSON.stringify(results));
