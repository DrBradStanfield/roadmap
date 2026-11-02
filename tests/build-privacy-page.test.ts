/**
 * scripts/build-privacy-page.mjs renders the published privacy pages
 * (drstanfield.com/pages/connector-privacy and /pages/app-privacy). It held two
 * raw NUL bytes as placeholder marks, so git treated it as a binary file and no
 * diff or PR review showed a change to it. Housekeeping (no user-facing
 * behaviour): the marks are written as \u0000 escapes, and the pages render the
 * same.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'scripts/build-privacy-page.mjs';

describe('build-privacy-page.mjs', () => {
  it('holds no raw NUL byte', () => {
    expect(readFileSync(join(ROOT, SCRIPT)).includes(0)).toBe(false);
  });

  it('is a text file to git, so a diff shows its lines', () => {
    const r = spawnSync('git', ['diff', '--no-index', '--numstat', '/dev/null', SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stdout).toMatch(/^\d+\t0\t/);
  });

  it.each(['connector', 'app'])('renders the %s page with every code span restored', (page) => {
    const dir = mkdtempSync(join(tmpdir(), 'privacy-page-'));
    try {
      const out = join(dir, 'page.html');
      const r = spawnSync(process.execPath, [SCRIPT, page, '--out', out], { cwd: ROOT, encoding: 'utf8', env: {} });
      expect(r.status, r.stderr).toBe(0);
      const html = readFileSync(out, 'utf8');
      expect(html).toContain('<code>');
      expect(html).not.toContain('\u0000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
