/**
 * US-28 AC8, US-23 AC14: reminders and the chat purge share one cron_lock row
 * across both Fly apps, so they run only on health-tool-app. Its fly.toml turns
 * them on with RUN_SHARED_CRONS = 'true' under [env]; fly.edu.toml never sets
 * the flag. Parsed by hand: a line scan of each [section], no TOML dependency.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each `key = value` line, with the [section] it sits under ('' before any). */
function entries(file: string): Array<{ section: string; key: string; value: string }> {
  let section = '';
  const out: Array<{ section: string; key: string; value: string }> = [];
  for (const raw of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = line.match(/^\[+([^\]]+)\]+$/);
    if (header) section = header[1].trim();
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kv) out.push({ section, key: kv[1], value: kv[2].trim() });
  }
  return out;
}

describe('RUN_SHARED_CRONS in the Fly configs (US-28 AC8, US-23 AC14)', () => {
  it("fly.toml (health-tool-app) sets RUN_SHARED_CRONS = 'true' under [env]", () => {
    const flag = entries('fly.toml').filter((e) => e.key === 'RUN_SHARED_CRONS');
    expect(flag).toHaveLength(1);
    expect(flag[0].section).toBe('env');
    expect(flag[0].value.replace(/^['"]|['"]$/g, '')).toBe('true');
  });

  it('fly.edu.toml (health-tool-edu) does not set it at all', () => {
    expect(readFileSync(join(ROOT, 'fly.edu.toml'), 'utf8')).not.toMatch(/RUN_SHARED_CRONS/);
  });
});
