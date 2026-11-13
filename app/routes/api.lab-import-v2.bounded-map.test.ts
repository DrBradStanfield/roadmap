/**
 * US-52 AC4f at the route: the lab upload's per-IP quota map is bounded, and a full map never
 * turns a NEW caller away. While the machine's file cap is spent, every upload is refused and
 * its IP charge handed back; once the cap resets, a new IP is served though the map filled up
 * meanwhile. The machine cap still refuses at its number. The map is built with a bound of 3
 * here (the factory, wrapped), so the test does not need 50,000 callers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/anthropic.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBatch: vi.fn(async () => ({ batchId: 'batch_abc' })),
}));
vi.mock('../lib/local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));
vi.mock('../lib/rate-limiter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rate-limiter')>();
  return { ...real, createQuotaCounter: (...[limit, windowMs, cleanupMs, options]: Parameters<typeof real.createQuotaCounter>) => real.createQuotaCounter(limit, windowMs, cleanupMs, { ...options, maxKeys: 3 }) };
});

import { machineFiles } from '../lib/rate-limiter';
import { action } from './api.lab-import-v2';

const FILES = [{ fileName: 'a.pdf', pages: [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }] }];

const upload = (ip: string) => action({
  request: new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST', headers: { 'fly-client-ip': ip }, body: JSON.stringify({ batch: true, files: FILES }),
  }),
} as never);

beforeEach(() => {
  machineFiles.reset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('US-52 AC4f: the lab upload quota with a full map', () => {
  it('serves a new IP after the machine cap resets, though refused uploads filled the map', async () => {
    machineFiles.take('machine', machineFiles.remaining('machine')); // the machine cap is spent
    for (const ip of ['10.8.0.1', '10.8.0.2', '10.8.0.3', '10.8.0.4']) expect((await upload(ip)).status).toBe(429);
    machineFiles.reset();
    const res = await upload('10.8.0.5');
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('the machine cap still refuses at its number with the map full', async () => {
    for (const ip of ['10.8.1.1', '10.8.1.2', '10.8.1.3']) expect((await upload(ip)).status).toBe(200);
    machineFiles.take('machine', machineFiles.remaining('machine'));
    expect((await upload('10.8.1.4')).status).toBe(429);
  });
});
