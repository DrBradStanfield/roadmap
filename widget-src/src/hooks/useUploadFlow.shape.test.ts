// US-12 AC26: the web's upload adapter holds no mode of its own. The upload's one named state is
// health-core's upload-flow.ts; the hook keeps, beside it, only view state (the connect-first skip),
// the state read synchronously, data held by file id or run, and synchronous claims. A boolean,
// a timer or a second phase here would be a mode beside the state (.claude/skills/untangle).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, 'useUploadFlow.ts'), 'utf8');
const read = readFileSync(join(__dirname, '../lib/upload-read.ts'), 'utf8');
/** The field names of one interface in upload-read.ts. */
const fieldsOf = (name: string) => {
  const line = read.match(new RegExp(`export interface ${name} \\{ (.*) \\}\\n`));
  if (line) return [...line[1].matchAll(/(?:^|; )(\w+)\??:/g)].map((m) => m[1]);
  const body = read.match(new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`))![1];
  return [...body.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]);
};
const all = (re: RegExp) => [...source.matchAll(re)].map((m) => m[1]);

describe('US-12 AC26: the upload adapter holds no mode beside the shared state', () => {
  it('its React state is the shared state, the connect-first skip and the bundle loader, nothing else', () => {
    expect(all(/const \[(\w+)(?:, \w+)?\] = useState/g)).toEqual(['upload', 'skipArchive', 'loadUploadBundle']);
  });

  it('its refs are the state read synchronously, held data and claims: none starts as a boolean', () => {
    // Design PR 10: the review's decisions and the save's counts went into the state (`chose`, `saved`);
    // left: a second once-per-run claim; Save's counts are read when it lands.
    expect(all(/const (\w+) = useRef/g)).toEqual(['live', 'held', 'prepared', 'reviewEnded', 'runCounted', 'endReview', 'props', 'port']);
    expect(source).not.toMatch(/useRef(<boolean>)?\((true|false)\)/);
  });

  it('it moves the state only through the shared transition, and keeps no timer', () => {
    expect(source).not.toMatch(/useReducer|setTimeout|setInterval/);
    expect(all(/setUpload\(([^)]*)\)/g)).toEqual(['step.state']);
  });

  // Adversary R2: a mode hidden in a field of a ref object is still a mode beside the state.
  it('the data the refs hold has only bytes, pages, per-file words and the pick\'s counts: no run outcome, no failure, no flag', () => {
    expect(fieldsOf('Held')).toEqual(['run', 'leftOut', 'docx', 'known', 'files']);
    expect(fieldsOf('HeldFile')).toEqual(['file', 'entry', 'pages', 'note']);
    expect(source).toMatch(/useRef<\{ run: number; ready: Promise<HealthUploadAPI \| null> \} \| null>\(null\)/);
    expect(source).not.toMatch(/SaveOutcome/);
    expect(read).not.toMatch(/\b(stopped|failure|refused|status|phase|mode)\??:/);
  });
});
