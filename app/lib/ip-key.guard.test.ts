/**
 * US-52 AC4k (untangle S-21): every per-IP limit builds its key with the one helper. The compiler
 * holds most of it: a per-IP limiter takes an `IpKey`, which only ip-key.server.ts makes. This scan
 * holds the rest: no other file casts to `IpKey`, every per-IP limiter is declared on it, and the
 * address is read outside the helper only where a named ruling keeps the address itself.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '..');
function appFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return appFiles(path);
    return /\.tsx?$/.test(name) && !/\.test(-helpers)?\.tsx?$/.test(name) ? [path] : [];
  });
}
const prod = appFiles(APP).map((file) => ({ file: relative(APP, file), text: readFileSync(file, 'utf8') }));
const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

/** Reads of the address that are not a limiter key, each with the ruling that keeps it. */
const ADDRESS_READS: Record<string, number> = {
  'lib/ip-key.server.ts': 1, // clientKey itself
  'lib/local-first-route.server.ts': 1, // getClientIp's own definition
  'routes/api.chat.ts': 1, // the guest session is bound to the address (S-21 owner ruling 2a); its limit is bucketed inside
  'lib/mcp-grants.server.ts': 1, // mcp token: vendor servers share egress ranges, so it stays on the address (owner ruling 1b)
};

describe('US-52 AC4k: every per-IP limit builds its key with the one helper', () => {
  it('reads the address only through clientKey, outside a named list', () => {
    const reads = Object.fromEntries(prod
      .map(({ file, text }) => [file, count(text, /\bgetClientIp\(/g)] as const)
      .filter(([, n]) => n > 0));
    expect(reads).toEqual(ADDRESS_READS);
  });

  it('makes an IpKey nowhere but the helper', () => {
    expect(prod.filter(({ text }) => /as IpKey\b/.test(text)).map(({ file }) => file)).toEqual(['lib/ip-key.server.ts']);
  });

  it('declares every per-IP limiter on IpKey', () => {
    const raw: string[] = [];
    for (const { text } of prod) {
      for (const call of text.matchAll(/(?<!function )create(?:RateLimiter|QuotaCounter)(<\w+>)?\(/g)) {
        const site = text.slice(call.index, text.indexOf('})', call.index) + 2);
        const name = /name: '([^']+)'/.exec(site)?.[1] ?? '';
        if (call[1] !== '<IpKey>') raw.push(name);
      }
    }
    // Names that say "per IP", and the per-IP limits whose names do not.
    const perIp = raw.filter((name) => / per IP$/.test(name) || ['mcp authorize', 'mcp reviewer failures'].includes(name));
    expect(perIp).toEqual([]);
    expect(raw).toContain('mcp token'); // the named exception above, on the address
  });
});
