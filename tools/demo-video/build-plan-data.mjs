// Derives src/plan-data.json from plan.json (real get_plan output on record.json).
// Run after: npx tsx tools/get-plan.ts tools/demo-video/record.json --json > tools/demo-video/plan.json
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(here, 'plan.json'), 'utf8'));
const record = JSON.parse(readFileSync(join(here, 'record.json'), 'utf8'));
const prev = JSON.parse(readFileSync(join(here, 'src/plan-data.json'), 'utf8'));

const pick = (id) => {
  const s = plan.suggestions.find((x) => x.id === id);
  if (!s) throw new Error(`suggestion ${id} missing from plan.json`);
  const {id: _, category, priority, title, description, reason, guidelines, references} = s;
  return {id, title, description, reason, guidelines, references, priority, category};
};
const apob = record.measurements
  .filter((m) => m.metricType === 'apob' && m.status === 'active')
  .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  .map((m) => ({date: m.recordedAt, value: m.value}));

const out = {
  apobSeries: apob,
  apobUnit: prev.apobUnit,
  apobCurrent: apob[apob.length - 1].value,
  beat2: (({category, ...rest}) => rest)(pick('med-ezetimibe')),
  beat3: prev.beat3.map((s) => (({category, ...rest}) => rest)(pick(s.id))),
  planLink: prev.planLink,
  generatedAt: plan.generatedAt,
};
writeFileSync(join(here, 'src/plan-data.json'), JSON.stringify(out, null, 2) + '\n');
console.log('plan-data.json rebuilt from plan generated', plan.generatedAt);
