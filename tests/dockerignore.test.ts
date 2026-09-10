/**
 * The Docker build is `COPY . .` (Dockerfile:20), so anything .dockerignore
 * misses is baked into the image. A manual `fly deploy` ships the WORKING
 * TREE, not HEAD, so the .gitignore patterns that exist to keep real health
 * data and backups out of the repo have to hold for the image too.
 *
 * This pins that: every .gitignore rule about health data, backups, dumps or
 * exports must be covered by .dockerignore.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function patterns(file: string): string[] {
  return readFileSync(join(ROOT, file), 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Docker's matcher, not git's: `*` and `?` stop at `/`, patterns are anchored
 * at the build-context root, and a trailing `/` matches the directory and
 * everything under it.
 */
function toRegExp(pattern: string): RegExp {
  const dir = pattern.endsWith('/');
  const body = (dir ? pattern.slice(0, -1) : pattern)
    .split('**')
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*');
  return new RegExp(`^${body}${dir ? '(/|$)' : '(/|$)'}`);
}

const DATA_WORDS = ['health', 'backup', 'dump', 'export'];

describe('.dockerignore covers the .gitignore data patterns', () => {
  // Docker anchors a bare pattern at the context root, so the file carries
  // `**/` where git recurses by default; the comparison drops that prefix.
  const dockerPatterns = patterns('.dockerignore').map((p) => p.replace(/^\*\*\//, ''));
  const dataRules = patterns('.gitignore').filter((p) =>
    DATA_WORDS.some((w) => p.toLowerCase().includes(w)),
  );

  it('finds the data rules to check (guards against a silently empty assertion)', () => {
    expect(dataRules.length).toBeGreaterThanOrEqual(6);
  });

  it.each(dataRules)('.dockerignore covers %s', (rule) => {
    const covered =
      dockerPatterns.includes(rule) ||
      dockerPatterns.some((d) => toRegExp(d).test(rule.replace(/\/$/, '')));
    expect(covered).toBe(true);
  });

  it('the build context still keeps what the server build reads', () => {
    // react-router build + runtime reads: app/, packages/, docs/, the root
    // prompt .md files, instrument*.mjs and the package files. None of them
    // may be excluded.
    const needed = [
      'app/lib/chat.server.ts',
      'packages/health-core/src/merge.ts',
      'docs/products.md',
      'docs/pathway/categories.json',
      'health_roadmap_algorithm.md',
      'instrument.server.mjs',
      'instrument-scrub.mjs',
      'package.json',
      'vite.config.ts',
      'react-router.config.ts',
    ];
    for (const path of needed) {
      const hit = dockerPatterns.find((d) => toRegExp(d).test(path));
      expect(hit, `${path} excluded by ${hit}`).toBeUndefined();
    }
  });
});
