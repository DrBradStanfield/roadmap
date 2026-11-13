/**
 * Counts the shape of the forwarded header on app-proxy requests, numbers
 * only (US-52 AC4h, untangle S-21; removal is lead S-21b). It changes no key:
 * `getClientIp` resolves the address as before and hands it here.
 *
 * Shape, under the rule PR 1b proposes: where Fly's entry (`Fly-Client-IP`)
 * sits in `X-Forwarded-For` — second to last (checked first), last, earlier,
 * absent — or no header at all; the hop count, 1 to 5+; and the family of the
 * address resolved today. Once an hour per process, and only when something
 * was counted, one fixed-format line of words and integers is logged. Never
 * an address, a header value, a customer id or a URL.
 */
import { isIP } from 'node:net';

export type ForwardedShape = 'anchor-last' | 'anchor-second-last' | 'anchor-earlier' | 'no-anchor' | 'no-header';
export type HopBucket = 'hops1' | 'hops2' | 'hops3' | 'hops4' | 'hops5plus';
export type IpFamily = 'v4' | 'v6' | 'unknown';

const SHAPES: ForwardedShape[] = ['anchor-last', 'anchor-second-last', 'anchor-earlier', 'no-anchor', 'no-header'];
const HOPS: HopBucket[] = ['hops1', 'hops2', 'hops3', 'hops4', 'hops5plus'];
const FAMILIES: IpFamily[] = ['v4', 'v6', 'unknown'];

/** The shape and hop bucket of one request's headers (no bucket when there are no hops). */
export function classifyForwarded(xff: string | null, flyIp: string | null): { shape: ForwardedShape; hops: HopBucket | null } {
  const hops = (xff ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
  const n = hops.length;
  if (n === 0) return { shape: 'no-header', hops: null };
  const fly = flyIp?.trim() || '';
  const shape: ForwardedShape = !fly || !hops.includes(fly) ? 'no-anchor'
    : hops[n - 2] === fly ? 'anchor-second-last'
    : hops[n - 1] === fly ? 'anchor-last'
    : 'anchor-earlier';
  return { shape, hops: HOPS[Math.min(n, 5) - 1] };
}

/** The family of a resolved address: only that, never the address. */
export function ipFamily(ip: string): IpFamily {
  const family = isIP(ip);
  return family === 4 ? 'v4' : family === 6 ? 'v6' : 'unknown';
}

/** A counter of shapes, hop buckets and families; `drain` returns the line (or null) and starts again. */
export function createShapeCounter() {
  const counts = new Map<string, number>();
  const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  return {
    count(xff: string | null, flyIp: string | null, resolvedIp: string): void {
      const { shape, hops } = classifyForwarded(xff, flyIp);
      bump(shape);
      if (hops) bump(hops);
      bump(ipFamily(resolvedIp));
    },
    drain(): string | null {
      if (counts.size === 0) return null;
      const line = 'forwarded-shape ' + [...SHAPES, ...HOPS, ...FAMILIES].map((name) => `${name}=${counts.get(name) ?? 0}`).join(' ');
      counts.clear();
      return line;
    },
  };
}

const HOUR_MS = 60 * 60_000;
const counter = createShapeCounter();
const counted = new WeakSet<Request>();

/** Count one request once, however many times its route reads the address. */
export function countForwardedShape(request: Request, resolvedIp: string): void {
  if (counted.has(request)) return;
  counted.add(request);
  counter.count(request.headers.get('x-forwarded-for'), request.headers.get('fly-client-ip'), resolvedIp);
}

/** The hourly line. Unref'd: never holds the process open. */
const forwardedShapeTimer = setInterval(() => {
  const line = counter.drain();
  if (line) console.log(line);
}, HOUR_MS);
forwardedShapeTimer.unref?.();
