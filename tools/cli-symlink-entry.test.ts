/**
 * US-32 AC56a: six more CLIs run when they are started through a symlinked folder.
 *
 * AC56 fixed the record tools; these six kept the old compare of `import.meta.url`
 * (Node gives the real path) with `process.argv[1]` (as typed). Through a symlink
 * to the checkout they skipped their CLI, printed nothing and exited 0.
 *
 * Every call here must fail at once, before any network, file write or browser:
 * a usage error or a refusal, exit 1. webkit-verify gets an empty browsers folder,
 * so its WebKit launch fails before any page opens. The children get no tokens.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-expect-error plain .mjs script
import { findVitest } from '../scripts/test-all-locked.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
// Imports the module named by the last argument, so argv[1] stays the argument that names no file,
// and prints the module's own tag, which only a finished import gives.
const IMPORT_LAST_ARG = 'process.stdout.write(Object.prototype.toString.call(await import(process.argv.at(-1))))';

/** A child's working folder is the real path, and test-all-locked looks for vitest above it: so look above that. */
const vitestAbove = (folder: string) => findVitest(realpathSync(folder));

let dir: string;
let linked: string;
let noBrowsers: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-symlink-entry-'));
  linked = join(dir, 'repo');
  symlinkSync(ROOT, linked, 'dir');
  noBrowsers = join(dir, 'no-browsers');
  mkdirSync(noBrowsers);
  // With a vitest above the temp folder, the test-all-locked rows would start a real suite run.
  expect(vitestAbove(dir), `TMPDIR must sit outside any checkout (vitest found above ${realpathSync(dir)})`).toBeNull();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CASES = [
  // cwd is a fresh temp folder, so no vitest is found above it.
  { file: 'scripts/test-all-locked.mjs', args: [], says: 'test:all: no node_modules/.bin/vitest found above' },
  { file: 'tools/agent-channel.mjs', args: [], says: 'agent-channel: usage: agent-channel.mjs read' },
  { file: 'scripts/build-master-html.mjs', args: [], says: 'Usage: build-master-html.mjs <master.md>' },
  { file: 'tools/search-knowledge.ts', args: [], says: 'search_knowledge: ' },
  // The checkout has its state file, so --init-state refuses; --probe writes nothing either way.
  { file: 'tools/knowledge-lint.ts', args: ['--init-state', '--probe'], says: 'lint-state.json exists; --init-state writes only the first one.' },
  { file: 'tools/webkit-verify.mjs', args: [], says: "Executable doesn't exist" },
];

/** Node with tsx for a .ts file, from a folder outside the repo, with no tokens in its env. */
function node(file: string, argv: string[]) {
  const loader = file.endsWith('.ts') ? ['--import', TSX] : [];
  return spawnSync(process.execPath, [...loader, ...argv], {
    cwd: dir, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', TZ: 'UTC', CI: '1', PLAYWRIGHT_BROWSERS_PATH: noBrowsers },
  });
}

describe('US-32 AC56a: a CLI started through a symlinked folder runs', () => {
  for (const { file, args, says } of CASES) {
    describe(file, () => {
      it('through a symlink to the checkout, it runs and refuses the bad call', () => {
        const r = node(file, [join(linked, file), ...args]);
        expect(r.stdout + r.stderr).toContain(says);
        expect(r.status).toBe(1);
      }, 60_000);

      it('by its real path (control), the same', () => {
        const r = node(file, [join(ROOT, file), ...args]);
        expect(r.stdout + r.stderr).toContain(says);
        expect(r.status).toBe(1);
      }, 60_000);

      it('through a symlink with --preserve-symlinks-main, the same', () => {
        const r = node(file, ['--preserve-symlinks-main', join(linked, file), ...args]);
        expect(r.stdout + r.stderr).toContain(says);
        expect(r.status).toBe(1);
      }, 60_000);

      it('imported by other code, with an argument that names no file, it does not run', () => {
        const url = pathToFileURL(join(ROOT, file)).href;
        const r = node(file, ['--input-type=module', '-e', IMPORT_LAST_ARG, 'no-such-file', url]);
        expect(r.stdout + r.stderr).toBe('[object Module]');
        expect(r.status).toBe(0);
      }, 60_000);
    });
  }
});

describe('US-32 AC56a: the TMPDIR check before the rows', () => {
  it('finds a vitest above a temp folder reached through a symlink into a checkout', () => {
    const checkout = join(dir, 'checkout');
    mkdirSync(join(checkout, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(checkout, 'node_modules', '.bin', 'vitest'), '');
    mkdirSync(join(checkout, 'tmp'));
    const alias = join(dir, 'tmp-alias');
    symlinkSync(join(checkout, 'tmp'), alias, 'dir');
    expect(findVitest(alias)).toBeNull(); // by the path as given, the walk up misses it
    expect(vitestAbove(alias)).toBe(join(realpathSync(checkout), 'node_modules', '.bin', 'vitest'));
    expect(vitestAbove(dir)).toBeNull();
  });
});
