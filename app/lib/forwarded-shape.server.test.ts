/**
 * US-52 AC4h: the forwarded header's shape is counted, numbers only, and no
 * key changes. The shapes are PR 1b's test shapes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyForwarded, createShapeCounter, ipFamily } from './forwarded-shape.server';

const LINE = /^forwarded-shape anchor-last=\d+ anchor-second-last=\d+ anchor-earlier=\d+ no-anchor=\d+ no-header=\d+ hops1=\d+ hops2=\d+ hops3=\d+ hops4=\d+ hops5plus=\d+ v4=\d+ v6=\d+ unknown=\d+$/;
const F = '35.1.2.3';
const APP = '66.241.124.56';

describe('classifyForwarded (US-52 AC4h)', () => {
  it.each([
    [`6.6.6.6, 203.0.113.9, ${F}`, F, 'anchor-last', 'hops3'],
    [`198.51.100.77, ${F}`, F, 'anchor-last', 'hops2'],
    [`6.6.6.6, 203.0.113.9, ${F}, ${APP}`, F, 'anchor-second-last', 'hops4'],
    [`203.0.113.9, ${F}, ${APP}`, F, 'anchor-second-last', 'hops3'],
    [`6.6.6.6, ${F}, 203.0.113.9, ${F}, ${APP}`, F, 'anchor-second-last', 'hops5plus'],
    [`6.6.6.6, ${F}, 203.0.113.9, ${F}`, F, 'anchor-last', 'hops4'],
    [`${F}, ${APP}`, F, 'anchor-second-last', 'hops2'],
    [`6.6.6.6, ${F}, 203.0.113.9, ${APP}`, F, 'anchor-earlier', 'hops4'],
    [`6.6.6.6, ${F}, 7.7.7.7, 203.0.113.9, ${APP}`, F, 'anchor-earlier', 'hops5plus'],
    [`${F}, 203.0.113.9, ${APP}`, F, 'anchor-earlier', 'hops3'],
    [`6.6.6.6, 203.0.113.9`, F, 'no-anchor', 'hops2'],
    ['203.0.113.9', F, 'no-anchor', 'hops1'],
    [F, F, 'anchor-last', 'hops1'],
    ['198.51.100.4', null, 'no-anchor', 'hops1'],
    ['6.6.6.6, 198.51.100.4', '', 'no-anchor', 'hops2'],
    [null, F, 'no-header', null],
    [' , ,', F, 'no-header', null],
  ])('%s with Fly %s -> %s %s', (xff, fly, shape, hops) => {
    expect(classifyForwarded(xff, fly)).toEqual({ shape, hops });
  });
});

describe('ipFamily (US-52 AC4h)', () => {
  it.each([
    ['203.0.113.9', 'v4'],
    ['2001:db8::1', 'v6'],
    ['::ffff:203.0.113.9', 'v6'],
    ['unknown', 'unknown'],
    ['', 'unknown'],
  ])('%s -> %s', (ip, family) => expect(ipFamily(ip)).toBe(family));
});

describe('the counter line (US-52 AC4h)', () => {
  it('is null when nothing was counted, and starts again after each line', () => {
    const c = createShapeCounter();
    expect(c.drain()).toBeNull();
    c.count(`203.0.113.9, ${F}, ${APP}`, F, '203.0.113.9');
    c.count(`2001:db8::9, ${F}`, F, '2001:db8::9');
    c.count(null, F, F);
    expect(c.drain()).toBe('forwarded-shape anchor-last=1 anchor-second-last=1 anchor-earlier=0 no-anchor=0 no-header=1 hops1=0 hops2=1 hops3=1 hops4=0 hops5plus=0 v4=2 v6=1 unknown=0');
    expect(c.drain()).toBeNull();
  });

  it('keeps its fixed shape whatever the headers hold', () => {
    const c = createShapeCounter();
    const hostile = [
      'forwarded-shape v4=999999', 'anchor-last=7 v6=8', '<script>alert(1)</script>', 'a'.repeat(10_000),
      '%0aforwarded-shape', 'unknown=1, unknown=2', '"; DROP TABLE x; --', '‮\u0000', '1.2.3.4 v4=5',
    ];
    for (const text of hostile) {
      c.count(text, text, text);
      c.count(`${text}, ${F}`, F, text);
      c.count(`${text}, ${F}, ${text}`, text, text);
    }
    const line = c.drain()!;
    expect(line).toMatch(LINE);
    for (const text of hostile) if (!/^[a-z0-9=-]+$/.test(text)) expect(line).not.toContain(text);
    expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+|:[0-9a-f]*:|script|DROP|999999/);
  });
});

describe('the hourly log line (US-52 AC4h)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('getClientIp counts each request once, keeps its answer, and logs one line an hour only when something was counted', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    const { getClientIp } = await import('./local-first-route.server');
    const request = new Request('https://x.test/?logged_in_customer_id=555', {
      headers: { 'x-forwarded-for': `6.6.6.6, 203.0.113.9, ${F}, ${APP}`, 'fly-client-ip': F },
    });
    expect(getClientIp(request, 'shopify')).toBe('203.0.113.9');
    expect(getClientIp(request, 'shopify')).toBe('203.0.113.9'); // the same request is counted once
    expect(getClientIp(new Request('https://x.test/', { headers: { 'fly-client-ip': F } }), 'fly')).toBe(F); // fly mode is not counted
    vi.advanceTimersByTime(60 * 60_000);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toMatch(LINE);
    expect(line).toBe('forwarded-shape anchor-last=0 anchor-second-last=1 anchor-earlier=0 no-anchor=0 no-header=0 hops1=0 hops2=0 hops3=0 hops4=1 hops5plus=0 v4=1 v6=0 unknown=0');
    expect(line).not.toMatch(/555|203\.0|x\.test/);
    vi.advanceTimersByTime(60 * 60_000);
    expect(log).toHaveBeenCalledTimes(1); // nothing counted: no line
  });
});
