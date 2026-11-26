/**
 * US-09 AC63: chat message packs are retired. No app subscribes to orders/paid,
 * every webhook a Shopify app config subscribes to has its route, and no server
 * code reads a pack variant id.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIGS = ['shopify.app.toml', 'shopify.app.edu.toml'];

function subscriptions(file: string): { topics: string[]; uri: string }[] {
  const blocks = readFileSync(file, 'utf8').split('[[webhooks.subscriptions]]').slice(1);
  return blocks.map((block) => ({
    topics: [...(block.match(/topics\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    uri: block.match(/uri\s*=\s*"([^"]+)"/)?.[1] ?? '',
  }));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test(-helpers)?\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Shopify webhook subscriptions (US-09 AC63)', () => {
  it.each(CONFIGS)('%s subscribes to no orders/paid webhook', (file) => {
    const subs = subscriptions(file);
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.flatMap((s) => s.topics)).not.toContain('orders/paid');
    expect(subs.map((s) => s.uri)).not.toContain('/webhooks/orders-paid');
  });

  it.each(CONFIGS)('%s subscribes only to webhooks that have a route', (file) => {
    for (const { uri } of subscriptions(file)) {
      const base = join('app/routes', uri.replace(/^\//, '').replace(/\//g, '.'));
      expect([`${base}.ts`, `${base}.tsx`].some(existsSync), uri).toBe(true);
    }
  });

  it('no server code reads a message pack variant id', () => {
    const readers = sourceFiles('app').filter((f) => readFileSync(f, 'utf8').includes('MESSAGE_PACK_'));
    expect(readers).toEqual([]);
  });
});
