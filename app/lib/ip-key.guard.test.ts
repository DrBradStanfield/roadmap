/**
 * US-52 AC4k (untangle S-21): every per-IP limit builds its key with the one helper. The compiler
 * holds most of it: a per-IP limiter takes an `IpKey`, which only ip-key.server.ts makes. This scan
 * holds the rest: no other file casts to `IpKey`, every limiter states its key type (`IpKey` or
 * `PlainKey`, which an `IpKey` cannot reach), no key is joined into a plain string, and the address
 * is read outside the helper only where a named ruling keeps the address itself.
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

  it('states the key type of every limiter, so the compiler keeps an address key out of any other limiter', () => {
    // A limiter with no stated type is keyed on `never`, and `PlainKey` refuses an `IpKey`: the type checker does the rest.
    const unstated = prod.flatMap(({ file, text }) => [...text.matchAll(/(?<!function )create(?:RateLimiter|QuotaCounter)(<\w+>)?\(/g)]
      .filter((call) => call[1] !== '<IpKey>' && call[1] !== '<PlainKey>')
      .map(() => file));
    expect(unstated).toEqual([]);
    const factories = prod.find(({ file }) => file === 'lib/rate-limiter.ts')!.text;
    expect(count(factories, /export function create(?:RateLimiter|QuotaCounter)<K extends string = never>\(/g)).toBe(2);
  });

  it('builds no limiter key from an address key by joining strings', () => {
    // The one gap the compiler leaves: a template or `+` turns an IpKey into a plain string. scopedKey is the way.
    expect(prod.filter(({ file, text }) => file !== 'lib/ip-key.server.ts' && joinsAnIpKey(text)).map(({ file }) => file)).toEqual([]);
    // The scan sees the shapes it exists for (the log brake's keys before scopedKey).
    expect(joinsAnIpKey("allowRateLimitEvent(`register:${clientKey(request, 'fly')}`)")).toBe(true);
    expect(joinsAnIpKey('const ip = clientKey(request, \'fly\');\nallowRateLimitEvent(`${reason}:${ip}`);')).toBe(true);
    expect(joinsAnIpKey('function f(ip: IpKey) { return limit(\'x:\' + ip); }')).toBe(true);
    expect(joinsAnIpKey('const ip = clientKey(request, \'fly\');\nallowRateLimitEvent(scopedKey(reason, ip));')).toBe(false);
  });
});

/** True when the text joins a value from the key helpers, or a name holding one, into a string. */
function joinsAnIpKey(text: string): boolean {
  const names = [
    ...[...text.matchAll(/\b(\w+)\s*=\s*(?:clientKey|ipBucket|hashedKey|scopedKey)\(/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(\w+)\??:\s*IpKey\b/g)].map((m) => m[1]),
  ];
  const key = `(?:${['(?:clientKey|ipBucket|hashedKey|scopedKey)\\(', ...names.map((n) => `\\b${n}\\b(?!\\()`)].join('|')})`;
  return new RegExp(`(?:\\$\\{|\\+)\\s*${key}|${key}\\s*\\+(?!\\+)`).test(text);
}
