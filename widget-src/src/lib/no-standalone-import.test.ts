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

// These forms, for a path under `.../standalone/` or the bare `.../standalone` folder: `from`
// (import, import type, export from), a side-effect `import '...'`, `import(...)`, `require(...)`,
// `import.meta.glob(...)`, and CSS `@import` with a quoted path or `url(...)`, quoted or not.
// Not caught: a comment between `import` and its path, `new URL(..., import.meta.url)`,
// `/// <reference path>`, `require.resolve(...)`, a CSS `url(...)` asset, and a quoted path
// with a space or a `)` before `/standalone`.
const NAMES_STANDALONE =
  /(?:\bfrom|\bimport|\brequire|\bimport\.meta\.glob)\s*\(?\s*\[?\s*(?:url\(\s*['"`]?|['"`])[^'"`)\s]*\/standalone(?:[\/'"`)\s])/;

describe('widget-src/src must not import widget-src/standalone (the forms above)', () => {
  it('no production file under src names a standalone module', () => {
    const offenders = sources(SRC).filter((file) => NAMES_STANDALONE.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});
