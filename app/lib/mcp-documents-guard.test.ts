// The hosted MCP server never writes or reads uploaded documents through the
// shared adapters (US-14; the opt-in `{ documents: 'write' }`, health-core
// adapter.ts). Its adapters are built bare, so the default refusal holds, and
// no server source imports the shared document functions that bypass it.
// A convention without this test would rest on memory (adversary R2, 2026-10-22).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '..');
const BYPASSES = ['dropboxUploadDocument', 'driveUploadDocument', 'driveDownloadDocument', 'driveEnsureSubfolder'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('hosted MCP server: no document writes (US-14)', () => {
  it('builds its cloud adapters bare, so they refuse document reads and writes', () => {
    const server = readFileSync(join(APP, 'lib/mcp.server.ts'), 'utf8');
    const built = [...server.matchAll(/new (Drive|Dropbox)Adapter\(([^)]*)\)/g)];
    expect(built.length).toBeGreaterThan(0);
    for (const [call, , args] of built) expect(args.split(',').length, call).toBe(1);
  });

  it('no server source imports the shared document functions', () => {
    for (const file of sources(APP)) {
      const text = readFileSync(file, 'utf8');
      for (const name of BYPASSES) expect(text.includes(name), `${file} uses ${name}`).toBe(false);
    }
  });
});
