/**
 * .env.example is the list a developer copies to run the server, so it should
 * name every variable the server reads and nothing it does not. Housekeeping
 * (no user-facing behaviour). This scans production server code for env reads
 * (`env.X`, `env['X']`, and the keys handed to dynamic lookups) and checks both
 * directions. Variables Fly or Node set on their own are left out on purpose.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SET_BY_PLATFORM = new Set(['NODE_ENV', 'FLY_APP_NAME', 'FLY_MACHINE_ID', 'PORT', 'HOST']);
const READS = [
  /\b[eE]nv\.([A-Z][A-Za-z0-9_]+)\b/g,
  /\b[eE]nv\[\s*['"]([A-Z][A-Za-z0-9_]+)['"]\s*\]/g,
  /\b(?:envKey|idVar|secretVar)\s*:\s*['"]([A-Z][A-Za-z0-9_]+)['"]/g,
];

const tracked = (...paths: string[]) =>
  execFileSync('git', ['ls-files', ...paths], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const source = (f: string) => readFileSync(join(ROOT, f), 'utf8');

const serverFiles = tracked('app', 'server.ts', 'instrument.server.mjs', 'packages/health-core/src')
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.(test|spec)\./.test(f));
const readByServer = new Map<string, string>();
for (const f of serverFiles) {
  const text = source(f);
  for (const re of READS) for (const [, name] of text.matchAll(re)) if (!readByServer.has(name)) readByServer.set(name, f);
}

const listed = [...source('.env.example').matchAll(/^([A-Z][A-Za-z0-9_]*)=/gm)].map(([, name]) => name);
// Anything outside the docs that builds, deploys or runs the app.
const elsewhere = tracked('app', 'server.ts', 'instrument.server.mjs', 'packages', 'tools', 'scripts', 'widget-src', 'vite.config.ts', 'Dockerfile', '.github', 'fly.toml', 'fly.edu.toml')
  .filter((f) => !/\.(md|png|jpe?g|gif|webp|pdf|mp4|woff2?)$/.test(f))
  .map(source)
  .join('\n');

describe('.env.example', () => {
  it('names every variable the server reads', () => {
    const missing = [...readByServer]
      .filter(([name]) => !listed.includes(name) && !SET_BY_PLATFORM.has(name))
      .map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
  });

  it('names nothing that nothing reads', () => {
    expect(listed.filter((name) => !new RegExp(`\\b${name}\\b`).test(elsewhere))).toEqual([]);
  });

  it('lists each variable once', () => {
    expect(listed.filter((name, i) => listed.indexOf(name) !== i)).toEqual([]);
  });
});
