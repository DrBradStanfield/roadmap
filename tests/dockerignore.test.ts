/**
 * The Docker build is `COPY . .` (Dockerfile:18), so anything .dockerignore
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

// 'research' (US-09 AC18): docs/wiki/research/ holds raw paywalled third-party source text.
const DATA_WORDS = ['health', 'backup', 'dump', 'export', 'research'];

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

  // US-09 AC9a: two gitignored folders hold other people's words rather than
  // health data, so the data-word filter above never compares them:
  // tools/output/ (YouTube dry runs: commenters' handles beside their comments)
  // and codex-drafts/ (drafts for a Codex review).
  it.each([
    ['tools/output/', 'tools/output/youtube-dryrun-abc.html'],
    ['codex-drafts/', 'codex-drafts/plan.md'],
  ])('.gitignore keeps %s out of the repo and .dockerignore keeps %s out of the image', (rule, path) => {
    expect(patterns('.gitignore')).toContain(rule);
    const hit = dockerPatterns.find((d) => toRegExp(d).test(path));
    expect(hit, `${path} would be copied into the image`).toBeDefined();
  });

  it('the build context still keeps what the server build reads', () => {
    // react-router build + runtime reads: app/, packages/, docs/, the root
    // prompt .md files, instrument*.mjs and the package files. None of them
    // may be excluded.
    const needed = [
      'app/lib/chat.server.ts',
      'packages/health-core/src/merge.ts',
      'docs/products.md',
      'docs/writing-style.md',
      'docs/chatbot/answer-bank.md',
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

// US-64 AC14: env variants, keys and certificates stay out of the repo and the
// image at any depth; the tracked template .env.example stays in both.
describe('secret files are ignored by git and Docker (US-64 AC14)', () => {
  const SECRETS = ['.env.*', '!.env.example', '*.pem', '*.key', '*.p8', '*.p12', 'service-account*.json'];
  const docker = patterns('.dockerignore');

  // Docker's rule: the LAST matching line wins, and `!` re-includes. `**/`
  // matches zero or more leading folders.
  function dockerIgnores(path: string): boolean {
    let ignored = false;
    for (const line of docker) {
      const neg = line.startsWith('!');
      const p = neg ? line.slice(1) : line;
      const any = p.startsWith('**/');
      const re = toRegExp(any ? p.slice(3) : p);
      const parts = path.split('/');
      const tails = any ? parts.map((_, i) => parts.slice(i).join('/')) : [path];
      if (tails.some((t) => re.test(t))) ignored = !neg;
    }
    return ignored;
  }

  it.each(SECRETS)('.gitignore lists %s', (rule) => {
    expect(patterns('.gitignore')).toContain(rule);
  });

  it.each([
    '.env.production', 'app/.env.staging', '.env.local', 'certs/server.pem', 'tls.key',
    'dist-cert.p12', 'service-account.json', 'tools/service-account-prod.json',
    'ios/AuthKey_ABC123.p8', // last on its line: gitleaks reads "Key... , 'x'" as a key assignment
  ])('.dockerignore keeps %s out of the image', (path) => {
    expect(dockerIgnores(path)).toBe(true);
  });

  it('.dockerignore keeps .env.example and the server inputs in the build context', () => {
    for (const path of ['.env.example', 'package.json', 'app/lib/chat.server.ts', 'app/lib/rate-limiter.env-cap.test.txt']) {
      expect(dockerIgnores(path), path).toBe(false);
    }
  });
});
