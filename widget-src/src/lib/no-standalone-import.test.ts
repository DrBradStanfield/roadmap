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

// Caught, for a quoted or `url(...)` path that holds `/standalone/` or ends in `/standalone`: `from`
// (import, import type, export from, CSS `composes`), a side-effect `import '...'`, `import(...)`
// (a type `import('...')` too), `require(...)` and `import x = require(...)`, `import.meta.glob(...)`
// (one pattern, or a quoted pattern first or later in an array, or `standalone` after `{` or `,` in
// a brace group), and CSS `@import` with a quoted path or `url(...)`, quoted or not.
// Not caught (forms.md): a comment between the keyword and the path, or before the pattern in a
// glob array; `new URL(..., import.meta.url)`, also inside `new Worker(...)`; `import.meta.resolve`;
// `/// <reference path>` and `/// <reference types>`; `declare module '...'`; `require.resolve`;
// a CSS `url(...)` asset, `image-set(...)` or `@IMPORT` in capitals; a quoted path with a space or a
// `)` before `/standalone`; a glob wildcard, class or extglob for the folder (`*`, `**`, `stand*`,
// `[s]`, `@(standalone)`); the glob `base` option; a template `import()` with `${}` for the folder;
// another letter case (`Standalone`); an escape (`\u0073`, CSS `\73`); a root-relative path such
// as `/app.tsx`, which the standalone build resolves in its root, `standalone/`; the bare folder
// with a query; `.html`, `.scss` or `.less` files; and a file outside src that one of them imports.
const NAMES_STANDALONE =
  /(?:\bfrom|\bimport|\brequire|\bimport\.meta\.glob)\s*\(?\s*\[?(?:\s*['"`][^'"`]*['"`]\s*,)*\s*(?:url\(\s*['"`]?|['"`])[^'"`)\s]*[\/{,]standalone(?:[\/'"`)\s},])/;

describe('widget-src/src must not import widget-src/standalone (the forms above)', () => {
  it('no production file under src names a standalone module', () => {
    const offenders = sources(SRC).filter((file) => NAMES_STANDALONE.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});
