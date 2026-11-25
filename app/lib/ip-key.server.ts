/**
 * The one key shape for every per-IP limit (US-52 AC4g, AC4k; untangle S-21).
 * A limiter keyed per IP takes an `IpKey`, and only this module makes one, so
 * a raw address cannot be passed as a limiter key by mistake: the compiler
 * refuses it, as it refuses an `IpKey` in any other limiter (`PlainKey`).
 * `app/lib/ip-key.guard.test.ts` holds the rest: no other file reads the
 * address for a limit, casts to `IpKey`, or joins one into a string.
 */
import { isIP } from 'node:net';
import { parseIpv6 } from './ip-groups.server';
import { getClientIp } from './local-first-route.server';

declare const ipKeyBrand: unique symbol;
/** A per-IP limiter key, made only by `ipBucket` (and so `clientKey`), `hashedKey` or `scopedKey`. */
export type IpKey = string & { readonly [ipKeyBrand]: true };
/**
 * Every other limiter's key. Any string is one, but an `IpKey` is not, so a key built from the
 * request's address cannot reach a limiter not declared on `IpKey` (US-52 AC4k).
 */
export type PlainKey = string & { readonly [ipKeyBrand]?: never };

/**
 * The per-IP bucket. IPv6 is keyed on its /64, which one subscriber holds
 * whole (adversary R4); IPv4 on the address, so many phones behind one
 * carrier NAT share a bucket, the price of having one at all.
 *
 * Total (US-52 AC4g): every spelling of one address is one key. Brackets, a
 * port and an IPv6 zone are dropped; IPv4-mapped IPv6, dotted or hex, is its
 * IPv4 address. Anything `isIP` does not take (IPv4 with leading zeros
 * included) is the one key `unknown`, `getClientIp`'s own fallback, so no
 * value becomes its own key. That key is limited like any other: a caller
 * whose address cannot be read shares it, and it never touches a readable
 * address's count. Never through `new URL`: it rewrites the dotted mapped
 * form to hex.
 */
export function ipBucket(raw: string | undefined): IpKey {
  let ip = (raw ?? '').trim();
  if (ip.length > 64) return UNKNOWN_IP;
  const hostPort = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(ip) ?? /^(\d+\.\d+\.\d+\.\d+):(\d{1,5})$/.exec(ip);
  if (hostPort && Number(hostPort[2] ?? 0) > 65535) return UNKNOWN_IP;
  if (hostPort) ip = hostPort[1];
  const zone = ip.indexOf('%');
  if (zone >= 0 && isIP(ip.slice(0, zone)) === 6) ip = ip.slice(0, zone);
  const family = isIP(ip);
  if (family === 4) return (hostPort?.[0].startsWith('[') ? UNKNOWN_IP : ip) as IpKey;
  const g = family === 6 ? parseIpv6(ip) : null;
  if (!g) return UNKNOWN_IP;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.') as IpKey;
  }
  return (g.slice(0, 4).map((x) => x.toString(16)).join(':') + '::/64') as IpKey;
}

const UNKNOWN_IP = 'unknown' as IpKey;

/** The request's per-IP key: the address the server already trusts for `trust`, folded by `ipBucket`. */
export const clientKey = (request: Request, trust: 'fly' | 'shopify'): IpKey => ipBucket(getClientIp(request, trust));

/**
 * A key that must not sit in memory as an address (US-15 AC7, US-17): the bucket, hashed. One bucket, one hash.
 * It keeps its kind: an IPv6 bucket's hash ends `/64` (a hash never does), and `unknown` is no address, so it stays.
 */
export const hashedKey = (key: IpKey, hash: (value: string) => string): IpKey => {
  const kind = ipKeyKind(key);
  return kind === 'unknown' ? key : (hash(key) + (kind === 'v6-bucket' ? '/64' : '')) as IpKey;
};

/** One count per `scope` for the same key (the MCP log brake counts per reason). It keeps its kind. */
export const scopedKey = (scope: string, key: IpKey): IpKey => `${scope}|${key}` as IpKey;

/** What a key stands for: an IPv4 address, an IPv6 /64, or a value that is not an address. */
export type IpKeyKind = 'v4' | 'v6-bucket' | 'unknown';
export function ipKeyKind(key: IpKey): IpKeyKind {
  const bare = key.slice(key.lastIndexOf('|') + 1);
  return bare === UNKNOWN_IP ? 'unknown' : bare.endsWith('/64') ? 'v6-bucket' : 'v4';
}

/**
 * A limit that depends on the key's kind, the one place one is set (Brad, 2026-11-26): an IPv6 /64 can hold
 * many unrelated people (carrier and relay egress), so the tightest shared limits give it more room.
 */
export const perKindLimit = (limits: Record<IpKeyKind, number>) => (key: IpKey): number => limits[ipKeyKind(key)];
