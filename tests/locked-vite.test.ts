/**
 * vite is a production dependency (the image runs `npm run build` with it), and
 * the lockfile held 6.4.4, the one version GHSA-8g5g-mxqh-grgj names. `npm
 * audit fix` moves it to 6.4.5 within the declared ^6.4.4. Housekeeping (no
 * user-facing behaviour): the built bundles are byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages as Record<string, { version?: string }>;
const parts = (v: string) => v.split('.').map(Number);
const atLeast = (v: string, min: string) => {
  const [a, b] = [parts(v), parts(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

describe('locked vite', () => {
  it('every locked vite is past the advisory (6.4.5 or later)', () => {
    const vites = Object.entries(lock).filter(([k]) => k === 'node_modules/vite' || k.endsWith('/node_modules/vite'));
    expect(vites.length).toBeGreaterThan(0);
    for (const [k, v] of vites) expect(atLeast(v.version!, '6.4.5'), `${k} ${v.version}`).toBe(true);
  });
});
