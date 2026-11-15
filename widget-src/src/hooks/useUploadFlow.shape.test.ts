// US-12 AC26: the web's upload adapter holds no mode of its own. The upload's one named state is
// health-core's upload-flow.ts; the hook keeps, beside it, only view state (the connect-first skip),
// the state read synchronously, data held by file id or run, and synchronous claims. A boolean,
// a timer or a second phase here would be a mode beside the state (.claude/skills/untangle).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, 'useUploadFlow.ts'), 'utf8');
const all = (re: RegExp) => [...source.matchAll(re)].map((m) => m[1]);

describe('US-12 AC26: the upload adapter holds no mode beside the shared state', () => {
  it('its React state is the shared state, the connect-first skip and the bundle loader, nothing else', () => {
    expect(all(/const \[(\w+)(?:, \w+)?\] = useState/g)).toEqual(['upload', 'skipArchive', 'loadUploadBundle']);
  });

  it('its refs are the state read synchronously, held data and claims: none starts as a boolean', () => {
    expect(all(/const (\w+) = useRef/g)).toEqual(['live', 'held', 'prepared', 'decisions', 'saved', 'reviewEnded', 'endReview', 'props', 'port']);
    expect(source).not.toMatch(/useRef(<boolean>)?\((true|false)\)/);
  });

  it('it moves the state only through the shared transition, and keeps no timer', () => {
    expect(source).not.toMatch(/useReducer|setTimeout|setInterval/);
    expect(all(/setUpload\(([^)]*)\)/g)).toEqual(['step.state']);
  });
});
