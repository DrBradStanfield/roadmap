/**
 * Save modes stay inside health-core (lead A1). Clients (the web widget, the
 * server and tools, the iPhone engine bridge) read only `saveStatus`,
 * `writePending` and `unsaved`, and the `SaveStatus` type; a client that
 * switched on a mode would break the day a mode folds away (held, lead A6).
 *
 * An exports map cannot enforce this: package.json exports `./*`, the vite
 * aliases point `@roadmap/health-core` at the source folder, and ios/engine
 * imports by relative path. So this reads the client source, comments
 * stripped, as engine-portability.test.ts does.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../..');
const CLIENT_DIRS = ['widget-src', 'app', 'tools', 'ios/engine'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

const ALLOWED = new Set(['saveStatus', 'writePending', 'unsaved', 'SaveStatus']);
const SPECIFIER = `['"](?:[^'"]*/)?save-state(?:\\.[cm]?[jt]s)?['"]`;
const MODES = 'clean|waiting|saving|failed|held|erasing';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Every way this source reaches past the save-state boundary. */
function violations(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const allowedImports = new RegExp(`\\bimport\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*${SPECIFIER}`, 'g');
  let cleared = 0;
  for (const m of code.matchAll(allowedImports)) {
    const names = m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean);
    const bad = names.filter((n) => !ALLOWED.has(n));
    if (bad.length) found.push(`imports ${bad.join(', ')} from save-state`);
    cleared++;
  }
  // Any other reach for the module: a namespace or default import, a
  // re-export, a dynamic import or require.
  const reaches = code.match(new RegExp(SPECIFIER, 'g'))?.length ?? 0;
  if (reaches > cleared) found.push('reaches save-state other than by a named import');
  for (const name of code.match(/\b(?:SaveState|SaveBase|SaveEvent)\b/g) ?? []) found.push(`names ${name}`);
  if (new RegExp(`\\.mode\\s*[!=]==?\\s*['"](?:${MODES})['"]`).test(code)) found.push('compares .mode with a save mode');
  if (/\bsave\w*\.mode\b/i.test(code)) found.push("reads a save state's .mode");
  return found;
}

function clientFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') ? [] : clientFiles(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

describe('save modes stay inside health-core (lead A1)', () => {
  it('no client file imports past saveStatus, writePending and unsaved, or switches on a save mode', () => {
    const files = CLIENT_DIRS.flatMap((dir) => clientFiles(join(REPO, dir)));
    expect(files.length).toBeGreaterThan(100); // the walk found the clients
    const offenders = files.flatMap((file) =>
      violations(readFileSync(file, 'utf8')).map((v) => `${relative(REPO, file)}: ${v}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan itself: allows the three readers and the status type', () => {
    expect(violations(`import { saveStatus, writePending, unsaved } from '../../packages/health-core/src/save-state';`)).toEqual([]);
    expect(violations(`import type { SaveStatus } from '@roadmap/health-core/save-state';`)).toEqual([]);
    expect(violations(`import { type SaveStatus, saveStatus as status } from './save-state.ts';`)).toEqual([]);
    // A CLI flag of the same spelling is not the module.
    expect(violations(`await capture(['--save-state'], root);`)).toEqual([]);
    // A comment is not code.
    expect(violations(`// SaveState lives in health-core; s.mode === 'held' is its business`)).toEqual([]);
  });

  it('the scan itself: catches every planted reach for a mode', () => {
    expect(violations(`import { saveStatus, SAVE_START } from '@roadmap/health-core/save-state';`)).toEqual([
      'imports SAVE_START from save-state',
    ]);
    expect(violations(`import type { SaveState } from '@roadmap/health-core/save-state';`)).toEqual([
      'imports SaveState from save-state',
      'names SaveState',
    ]);
    expect(violations(`import * as save from '../../packages/health-core/src/save-state';`)).toEqual([
      'reaches save-state other than by a named import',
    ]);
    expect(violations(`export { transition } from './save-state';`)).toEqual(['reaches save-state other than by a named import']);
    expect(violations(`const m = await import('@roadmap/health-core/save-state');`)).toEqual([
      'reaches save-state other than by a named import',
    ]);
    expect(violations(`function f(e: SaveEvent, b: SaveBase) {}`)).toEqual(['names SaveEvent', 'names SaveBase']);
    expect(violations(`if (state.mode === 'held') return;`)).toEqual(['compares .mode with a save mode']);
    expect(violations(`switch (session.saveState.mode) { default: }`)).toEqual(["reads a save state's .mode"]);
  });
});
