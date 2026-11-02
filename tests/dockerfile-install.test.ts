/**
 * The image's node_modules is `npm ci --omit=dev` from the lockfile, nothing
 * else. The Dockerfile also ran `npm remove @shopify/cli`, a line left from the
 * Shopify app template: @shopify/cli is not in the lockfile, so it removed
 * nothing from node_modules and only rewrote package-lock.json, which
 * `COPY . .` then overwrites. Housekeeping (no user-facing behaviour): the
 * line is gone, and no later step may change the installed packages.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// RUN instructions with their continuation lines joined, comments dropped.
const runs = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  .replace(/\\\n/g, ' ')
  .split('\n')
  .filter((l) => /^RUN\s/.test(l));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages as Record<string, unknown>;

describe('Dockerfile installs', () => {
  it('installs production packages from the lockfile once', () => {
    expect(runs.filter((r) => /\bnpm ci\b/.test(r))).toEqual(['RUN npm ci --omit=dev && npm cache clean --force']);
  });

  it('changes no installed package after that', () => {
    expect(runs.filter((r) => /\bnpm (remove|rm|uninstall|un|install|i|add|update|prune)\b/.test(r))).toEqual([]);
  });

  it('@shopify/cli is not a locked package, so there is nothing to remove', () => {
    expect(Object.keys(lock).filter((k) => k.endsWith('node_modules/@shopify/cli'))).toEqual([]);
  });
});
