/**
 * scripts/build-privacy-page.mjs renders the published privacy pages
 * (drstanfield.com/pages/connector-privacy and /pages/app-privacy). It held two
 * raw NUL bytes as placeholder marks, so git treated it as a binary file and no
 * diff or PR review showed a change to it. Housekeeping (no user-facing
 * behaviour): the marks are written as \u0000 escapes, and the pages render the
 * same.
 *
 * US-09 AC44: each notice carries one generated "Last updated <date>" line, the
 * UTC day it is built, with the clock injected through --date.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'scripts/build-privacy-page.mjs';
// Mirrors the script's PAGES: each master and the first line of its public body.
const MASTERS: Record<string, { md: string; start: string }> = {
  connector: { md: 'privacy-connector-addendum.md', start: 'This section covers one optional feature' },
  app: { md: 'privacy-app-addendum.md', start: 'This policy covers the Health Roadmap iPhone app' },
};

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

  const render = (page: string, date: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'privacy-page-'));
    try {
      const out = join(dir, 'page.html');
      const r = spawnSync(process.execPath, [SCRIPT, page, '--date', date, '--out', out], { cwd: ROOT, encoding: 'utf8', env: {} });
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(out, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each(['connector', 'app'])('US-09 AC44: the %s page says when it was last updated, once, near the top', (page) => {
    const html = render(page, '2026-11-11T23:30:00Z');
    const line = '<p>Last updated 11 November 2026</p>';
    expect(html.split(line).length - 1).toBe(1);
    expect(html.split('\n').indexOf(line)).toBe(1);
  });

  it.each(['connector', 'app'])('US-09 AC44: the %s page carries no second date line', (page) => {
    const html = render(page, '2026-03-01T00:00:00Z');
    expect(html).toContain('<p>Last updated 1 March 2026</p>');
    expect(html.match(/last updated|effective date|updated on/gi)).toHaveLength(1);
    // The master's header holds maintainer dates ("(last ...)", "Republished ...");
    // the build drops everything above the public body's first line.
    const master = readFileSync(join(ROOT, 'docs', MASTERS[page].md), 'utf8');
    const header = master.slice(0, master.indexOf('\n' + MASTERS[page].start));
    expect(header.length).toBeGreaterThan(0);
    for (const word of ['Republished', 'first published', '(last ']) expect(html).not.toContain(word);
    const lines = header.split('\n').map((l) => l.replace(/^>\s?/, '').trim()).filter((l) => l && !l.startsWith('#'));
    for (const l of lines) expect(html, l).not.toContain(l);
  });
});
