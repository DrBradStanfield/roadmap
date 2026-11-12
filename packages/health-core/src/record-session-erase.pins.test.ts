/**
 * The erase split (record-session-erase.ts) gave the session's erase fields up
 * to a free function: they lost `private` and are marked `@internal`. These
 * pins keep that seam from becoming API, and keep the erase names importable
 * from './record-session', the path the web store and the iPhone engine use
 * (US-09 AC23, US-11 AC6).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as session from './record-session';
import type { EraseResult, EraseSteps } from './record-session';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../..');
const DIRS = ['widget-src', 'app', 'tools', 'ios/engine', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const OWN = /^packages\/health-core\/src\/record-session[^/]*\.ts$/;
const INTERNAL = ['current', 'mode', 'revisionSeen', 'saveWarning', 'clearedFor', 'host', 'sync', 'cloudUnreachable',
  'tryClear', 'ctx', 'dispatch', 'replaceUnreadable'];

function* sources(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* sources(path);
    else if (SOURCE.test(e.name)) yield path;
  }
}

describe('record-session erase split', () => {
  it('no file outside record-session*.ts reads an @internal field off a session', () => {
    const read = new RegExp(`\\b\\w*[sS]ession\\??\\.(?:${INTERNAL.join('|')})\\b`);
    const found: string[] = [];
    for (const dir of DIRS) {
      for (const path of sources(join(REPO, dir))) {
        const rel = relative(REPO, path);
        if (OWN.test(rel)) continue;
        const text = readFileSync(path, 'utf8');
        text.split('\n').forEach((line, i) => { if (read.test(line)) found.push(`${rel}:${i + 1}`); });
      }
    }
    expect(found).toEqual([]);
  });

  it('every field the erase reads is @internal, so a stripInternal type surface hides it', () => {
    const file = join(REPO, 'packages/health-core/src/record-session.ts');
    const { outputText } = ts.transpileDeclaration(readFileSync(file, 'utf8'), {
      fileName: file, compilerOptions: { stripInternal: true },
    });
    const cls = outputText.slice(outputText.indexOf('export declare class RecordSession'));
    for (const name of INTERNAL) expect(cls, name).not.toMatch(new RegExp(`^ {4}(?:readonly )?${name}\\b`, 'm'));
    for (const name of ['erase', 'deleteAllData', 'clearOffFileData', 'flush']) expect(cls, name).toMatch(new RegExp(`^ {4}${name}\\(`, 'm'));
  });

  it('the erase names still come from ./record-session (ios/engine/cloud.ts, roadmap-store.ts)', () => {
    expect(session.ERASE_UNREACHABLE).toMatch(/nothing was deleted/);
    expect(session.ERASE_BUSY).toBe('Already deleting your data.');
    expect(session.ERASE_STALE_TAB).toMatch(/out of date/);
    expect(typeof session.RecordSession.prototype.deleteAllData).toBe('function');
    expect(typeof session.RecordSession.prototype.erase).toBe('function');
    const result: EraseResult = { success: false, error: session.ERASE_BUSY };
    const steps: EraseSteps = { teardown: async () => {} };
    expect([result.success, typeof steps.teardown]).toEqual([false, 'function']);
  });

  it('the importers name the path these pins check', () => {
    const imports = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
    expect(imports('ios/engine/cloud.ts')).toMatch(/import \{[^}]*\bERASE_UNREACHABLE\b[^}]*\} from '\.\.\/\.\.\/packages\/health-core\/src\/record-session';/);
    const store = imports('widget-src/src/storage/roadmap-store.ts');
    expect(store).toMatch(/type EraseResult, type EraseSteps \} from '@roadmap\/health-core\/record-session';/);
    expect(store).toMatch(/export \{ ERASE_UNREACHABLE \} from '@roadmap\/health-core\/record-session';/);
  });
});
