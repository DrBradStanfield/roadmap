import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// `src/` must never import `standalone/` (lib/storage-notice.tsx): the standalone app is built
// on src, not the other way round. Tests may reach into standalone; production files may not.
const SRC = join(__dirname, '..');

function scanned(name: string): boolean {
  return /\.(?:[cm]?[jt]sx?|css)$/.test(name) && !/\.test\.[jt]sx?$/.test(name);
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return scanned(name) ? [path] : [];
  });
}

// A regression check, not a proof: the test fails when a production file under widget-src/src names a
// standalone path in one of the forms PLANTED lists below. A form not in that list is not checked.
// Examples not checked (US-14 AC7a lists more): `import.meta.glob<M>(...)`; a `.pcss` or `.postcss` file; a
// glob array whose earlier item holds the other quote or an escaped one; `standalone{,-x}`; `(lib|standalone)`;
// a comment before the path; `new URL(..., import.meta.url)`; `/// <reference>`; a CSS `url(...)` asset;
// `Standalone`; an escape; `.html`, `.scss` and `.less` files; a file outside src that one of them imports.
const NAMES_STANDALONE =
  /(?:\bfrom|\bimport|\brequire|\bimport\.meta\.glob)\s*\(?\s*\[?(?:\s*['"`][^'"`]*['"`]\s*,)*\s*(?:url\(\s*['"`]?|['"`])[^'"`)\s]*[\/{,]standalone(?:[\/'"`)\s},])/;

const flags = (name: string, text: string) => scanned(name) && NAMES_STANDALONE.test(text);
type Row = [file: string, text: string];
const P = './../standalone'; // '.' + P is '../../standalone'; the dot stops declared-dependencies reading plants as packages
const ts = (...texts: string[]) => texts.map((text): Row => ['x.ts', text]);
const css = (...texts: string[]) => texts.map((text): Row => ['x.css', text]);
// The checked forms, each a file name and its text: each must be flagged.
const PLANTED: Row[] = [
  ...ts(`import x from '.${P}/x';`, `import {\n  a,\n} from ".${P}/x";`, `import type { X } from '.${P}/x';`),
  ...ts(`export { x } from '.${P}/x';`, `export * from '.${P}/x';`, `export * as ns from '.${P}/x';`, `import x from'.${P}/x';`),
  ...ts(`import d from '.${P}/d.json' with { type: 'json' };`), ...css(`.a { composes: b from '.${P}/x.module.css'; }`),
  ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'd.ts'].map((kind): Row => [`x.${kind}`, `import '.${P}/x';`]),
  ...ts(`const m = import('.${P}/x');`, `const m = import(\`.${P}/x\`);`, `const m = import(\n  '.${P}/x'\n);`),
  ...ts(`type T = import('.${P}/x').T;`, `type M = typeof import('.${P}/x');`, `const m = import('.${P}/d.json', { with: { type: 'json' } });`),
  ...ts(`const m = require('.${P}/x');`, `import x = require('.${P}/x');`),
  ...ts(`const m = import.meta.glob('.${P}/*.ts');`, `const m = import.meta.glob(['.${P}/*.ts']);`),
  ...ts(`const m = import.meta.glob('.${P}/*.svg', { query: '?raw', import: 'default', eager: true });`),
  ...ts(`export const m = import.meta.glob(['./*.ts', '.${P}/*.ts']);`, `const m = import.meta.glob(['!./x.ts', '.${P}/*.ts']);`),
  ...ts(`const m = import.meta.glob([\n  './a/*.ts',\n  "./b/*.ts",\n  '.${P}/*.ts',\n]);`, `const m = import.meta.glob(['./*.ts', '!.${P}/*.ts']);`),
  ...ts("const m = import.meta.glob('../../{lib,standalone}/*.ts');", "const m = import.meta.glob('../../{standalone,lib}/*.ts');"),
  ...ts("const m = import.meta.glob('../../{a,{b,standalone}}/*.ts');"),
  ...css(`@import '.${P}/x.css';`, `@import".${P}/x.css";`, `@import url(".${P}/x.css");`, `@import url('.${P}/x.css');`),
  ...css(`@import url(.${P}/x.css);`, `@import url( .${P}/x.css ) screen;`, `@import url(\n  .${P}/x.css\n);`),
  ...css(`@import '.${P}/x.css' layer(base) supports(display: grid);`, `@import url(.${P});`),
  ...ts(`import x from '.${P}';`, `import x from '.${P}/';`, `import W from '.${P}/w.ts?worker';`, `import s from '.${P}/x.ts?raw';`),
  ...ts(`import u from '.${P}/logo.svg?url';\nimport i from '.${P}/logo.svg?inline';`, "import x from '/standalone/x';"),
  ...ts("import x from '/@fs/repo/widget-src/standalone/x';", "import x from 'health-tool-widget/standalone/x';"),
  ...ts(`import x from '.${P}/../standalone/x';`),
];
// Controls: each must not be flagged.
const CONTROLS: Row[] = [
  ['x.test.ts', `import '.${P}/x';`],
  ...ts("import x from './not-standalone/x';", "import x from './standalone-mode';", "import './standalone.css';"),
  ...ts('// see widget-src/standalone/ for the app', "const u = 'https://example.com/standalone/x';"),
  ...css('@import url(./own.css);\n/* see widget-src/standalone/ */'),
  ...ts("const m = import.meta.glob(['./a/*.ts', './b/*.ts']);", "const m = import.meta.glob('./{a,b}/*.ts');"),
  ...ts("import a from './a';\nimport b from './b';\nconst xs = ['x', '../standalone/y'];", "import a from './a';\nf('a', '../standalone/y');"),
  ...ts("const surface = ok ? 'standalone' : 'website';"),
];

describe('widget-src/src must not import widget-src/standalone (the planted forms)', () => {
  it('no production file under src names a standalone module', () => {
    const offenders = sources(SRC).filter((file) => NAMES_STANDALONE.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
  it.each(PLANTED)('flags the planted form in %s: %s', (file, text) => expect(flags(file, text)).toBe(true));
  it.each(CONTROLS)('passes the control in %s: %s', (file, text) => expect(flags(file, text)).toBe(false));
});
