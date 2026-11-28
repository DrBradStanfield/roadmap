import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// `src/` must never import `standalone/` (lib/storage-notice.tsx): the standalone app is built
// on src, not the other way round. Tests may reach into standalone; production files may not.
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('widget-src/src never imports widget-src/standalone', () => {
  it('no production file under src names a standalone module', () => {
    const offenders = sources(SRC).filter((file) =>
      /(?:from\s+|import\s*\(\s*)['"][^'"]*\/standalone\//.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});
