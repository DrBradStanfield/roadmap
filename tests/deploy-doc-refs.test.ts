/**
 * CLAUDE.md and docs/deploy-runbook.md are what an agent or Brad follows to
 * rebuild and deploy. Three references in them had gone stale: a blog script
 * deleted in c024c08b, the widget's app-block.liquid path (it lives in
 * blocks/), and `shopify app deploy --force`, a flag the CLI that deploy.yml
 * pins (4.9.4) rejects ("Nonexistent flag: --force"). Housekeeping (no
 * user-facing behaviour): the docs name what exists and the flag CI uses.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['CLAUDE.md', 'docs/deploy-runbook.md'];
// Everything else that tells a reader how the Shopify deploy is run.
const FLAG_DOCS = [...DOCS, 'docs/architecture-v2/ops-deployment.md', 'docs/reference.md', 'widget-src/vite.config.shopify-prod.ts'];
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8').split('\n');

// Paths in this repo's scripts/ and extensions/ named inside `code` spans.
function namedPaths(doc: string): { line: number; path: string }[] {
  const out: { line: number; path: string }[] = [];
  read(doc).forEach((text, i) => {
    for (const [, span] of text.matchAll(/`([^`]+)`/g)) {
      for (const [path] of span.matchAll(/\b(?:scripts|extensions)\/[\w./-]+\.\w+/g)) out.push({ line: i + 1, path });
    }
  });
  return out;
}

describe('deploy docs name what exists', () => {
  it.each(DOCS)('%s: every scripts/ and extensions/ file it names exists', (doc) => {
    const named = namedPaths(doc);
    expect(named.length).toBeGreaterThan(0);
    const missing = named.filter(({ path }) => !existsSync(join(ROOT, path))).map(({ line, path }) => `${doc}:${line} ${path}`);
    expect(missing).toEqual([]);
  });

  it('the Shopify deploy commands use the flag deploy.yml uses, not --force', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(workflow).toMatch(/shopify app deploy --allow-updates/);
    // Each command as written: from `shopify app deploy` (or the diagram's bare
    // `deploy --flag`) to the end of its code span or line.
    const commands = FLAG_DOCS.flatMap((doc) =>
      read(doc).flatMap((text, i) =>
        [...text.matchAll(/shopify app deploy[^`\n]*|\bdeploy --[\w-]+/g)].map(([c]) => `${doc}:${i + 1} ${c.trim()}`)),
    );
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((c) => /--force\b/.test(c))).toEqual([]);
  });
});
