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
    return /\.(?:[cm]?[jt]sx?|css)$/.test(name) && !/\.test\.[jt]sx?$/.test(name) ? [path] : [];
  });
}

// Every import form: `from` (import, import type, export from), a side-effect `import '...'`,
// `import(...)`, `require(...)`, `import.meta.glob(...)` and CSS `@import`, and the bare
// `.../standalone` path as well as `.../standalone/...`.
const NAMES_STANDALONE =
  /(?:\bfrom|\bimport|\brequire|\bimport\.meta\.glob)\s*\(?\s*\[?\s*(?:url\(\s*)?['"`][^'"`]*\/standalone(?:\/|['"`])/;

describe('widget-src/src never imports widget-src/standalone', () => {
  it('no production file under src names a standalone module', () => {
    const offenders = sources(SRC).filter((file) => NAMES_STANDALONE.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});
