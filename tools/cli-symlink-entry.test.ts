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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

let dir: string;
let linked: string;
let noBrowsers: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-symlink-entry-'));
  linked = join(dir, 'repo');
  symlinkSync(ROOT, linked, 'dir');
  noBrowsers = join(dir, 'no-browsers');
  mkdirSync(noBrowsers);
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
        const r = node(file, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`, 'no-such-file']);
        expect(r.stdout + r.stderr).toBe('');
        expect(r.status).toBe(0);
      }, 60_000);
    });
  }
});
