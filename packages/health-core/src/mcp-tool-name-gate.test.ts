/**
 * US-32 AC1a: a name every JavaScript object carries is not a tool.
 *
 * `toString`, `constructor`, `__proto__` and `hasOwnProperty` are found on
 * any plain object through its prototype. A tool call by one of those names
 * must get the same "No tool named" answer as a made-up name, before the
 * record is opened, and the nine real names must still run. Synthetic record.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import { MCP_TOOLS } from './mcp-tool-catalogue';
import { isToolName, runToolOverSync } from './mcp-tools';
import type { SyncManager } from './sync-manager';

const NOW = '2026-11-26T12:00:00.000Z';
const INHERITED = ['toString', 'constructor', '__proto__', 'hasOwnProperty'];

/** A record store that counts what the call did to it. */
function countingSync() {
  const calls = { load: 0, save: 0, beforeCall: 0 };
  const file = createEmptyFile({ deviceId: 'device-synthetic', now: NOW });
  const sync = {
    load: async () => { calls.load++; return file; },
    save: async (f: RoadmapFile) => { calls.save++; return { file: f }; },
  } as unknown as SyncManager<RoadmapFile>;
  const beforeCall = () => { calls.beforeCall++; return null; };
  return { sync, calls, beforeCall };
}

describe('US-32 AC1a: a name every object carries is not a tool', () => {
  it('isToolName is true for the nine published names only', () => {
    for (const tool of MCP_TOOLS) expect(isToolName(tool.name), tool.name).toBe(true);
    for (const name of [...INHERITED, 'no_such_tool']) expect(isToolName(name), name).toBe(false);
  });

  it.each(INHERITED)('%s gets the made-up name answer, and no record is opened', async (name) => {
    const made = countingSync();
    const control = await runToolOverSync(made.sync, 'no_such_tool', {}, NOW, { beforeCall: made.beforeCall });
    const { sync, calls, beforeCall } = countingSync();
    const answer = await runToolOverSync(sync, name, {}, NOW, { beforeCall });
    expect(answer).toEqual({ ...control, text: `No tool named ${name}.` });
    expect(answer).toEqual({ text: `No tool named ${name}.`, isError: true, reason: 'malformed' });
    expect(calls).toEqual({ load: 0, save: 0, beforeCall: 0 });
    expect(made.calls).toEqual({ load: 0, save: 0, beforeCall: 0 });
  });

  it('a real tool still opens the record and answers', async () => {
    const { sync, calls, beforeCall } = countingSync();
    const read = await runToolOverSync(sync, 'read_record', {}, NOW, { beforeCall });
    expect(read.isError).toBe(false);
    expect(calls).toEqual({ load: 1, save: 0, beforeCall: 1 });

    const added = await runToolOverSync(sync, 'add_measurement', { metricType: 'weight', value: 70, recordedAt: '2026-11-26' }, NOW, { beforeCall });
    expect(added.isError).toBe(false);
    expect(calls).toEqual({ load: 2, save: 1, beforeCall: 2 });
  });
});
