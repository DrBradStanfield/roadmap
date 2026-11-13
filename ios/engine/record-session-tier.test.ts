// S69 (US-11 AC4c): the iPhone opens a RecordSession only over the cloud host.
// A device-tier erase now puts the copy back on a definite refusal
// (record-session-erase.ts). The iPhone never meets that path: its phone-only
// erase is eraseOnPhone (erase.ts), which Swift writes itself, and its one
// device-tier host (app-doors.ts memoryHost) serves the chat history only.
// A source scan, not a behavioural test: the question is which hosts the
// engine's code can hand to RecordSession.open, and only the source answers
// that for code no test runs yet. A device-tier RecordSession on the phone
// must come back through this question first.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here, { recursive: true, encoding: 'utf8' })
  .filter((name) => !name.includes('node_modules'))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
  .map((name) => ({ name, text: readFileSync(join(here, name), 'utf8') }));
const withMatch = (pattern: RegExp) => sources.filter((s) => pattern.test(s.text)).map((s) => s.name);

describe('S69: the iPhone runs no device-tier RecordSession', () => {
  it('the scan reads the engine sources', () => {
    expect(sources.map((s) => s.name)).toEqual(expect.arrayContaining(['cloud.ts', 'app-doors.ts', 'erase.ts']));
  });

  it('cloud.ts is the only file that opens a RecordSession, and it opens one once', () => {
    expect(withMatch(/RecordSession\s*\.\s*open\b/)).toEqual(['cloud.ts']);
    const cloud = sources.find((s) => s.name === 'cloud.ts')!.text;
    expect(cloud.match(/RecordSession\s*\.\s*open\b/g)).toHaveLength(1);
    expect(cloud).toMatch(/session = await RecordSession\.open\(host\)/);
  });

  it('the host cloud.ts opens it over is the cloud tier, by type and by value', () => {
    const cloud = sources.find((s) => s.name === 'cloud.ts')!.text;
    expect(cloud).toMatch(/type CloudHost = Extract<RecordHost, \{ tier: 'cloud' \}>/);
    expect(cloud).toMatch(/return \{\s*tier: 'cloud',/);
    expect(cloud).not.toMatch(/['"`]device['"`]/);
  });

  it("the only device-tier host is app-doors.ts's chat-history host, which never reaches a RecordSession", () => {
    expect(withMatch(/tier:\s*['"`]device['"`]/)).toEqual(['app-doors.ts']);
    const doors = sources.find((s) => s.name === 'app-doors.ts')!.text;
    expect(doors).not.toMatch(/record-session|RecordSession|eraseSession|deleteAllDataSession/);
  });

  it('no engine file calls the record erase paths directly', () => {
    expect(withMatch(/\beraseSession\b|\bdeleteAllDataSession\b|record-session-erase/)).toEqual([]);
  });
});
