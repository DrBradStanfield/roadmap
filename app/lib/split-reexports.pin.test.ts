// S-14 (untangle ledger): the post-split re-export blocks are gone, so each
// name has one import path, its defining module. A re-export coming back fails
// here. supabase.server.ts keeps only the dashboard and A/B names.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

/** Every `export { ... } from '<module>'` in the file, as module -> names (type-only marks dropped). */
function reExports(file: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of read(file).matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const names = m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '')).filter(Boolean);
    out[m[2]] = [...(out[m[2]] ?? []), ...names].sort();
  }
  return out;
}

describe('S-14: no post-split re-export blocks', () => {
  it('supabase.server.ts re-exports only the dashboard and A/B names', () => {
    const got = reExports('supabase.server.ts');
    expect(got['./supabase-client.server']).toBeUndefined();
    expect(got['./supabase-identity.server']).toBeUndefined();
    expect(got['./supabase-guest.server']).toBeUndefined();
    expect(got['./supabase-account.server']).toBeUndefined();
    expect(got['./supabase-cron-lock.server']).toBeUndefined();
    expect(Object.keys(got).sort()).toEqual(['./supabase-ab.server', './supabase-dashboard.server']);
  });

  it('youtube-bot.server.ts re-exports nothing from its config, api or store modules', () => {
    expect(Object.keys(reExports('youtube-bot.server.ts'))).toEqual(['./youtube-bot-pipeline.server']);
  });

  it('discord-bot.server.ts re-exports nothing', () => {
    expect(reExports('discord-bot.server.ts')).toEqual({});
  });
});
