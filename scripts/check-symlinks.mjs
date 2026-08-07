#!/usr/bin/env node
/**
 * Guard: files that MUST stay symlinks must never be committed as real files.
 *
 * Why this exists
 * ---------------
 * `docs/products.md` is a symlink to the claude_business master copy. Fly's
 * remote Docker builder cannot follow it, so the documented deploy sequence
 * dereferences it to a real file, deploys, then restores the symlink with
 * `git checkout docs/products.md`.
 *
 * If a commit lands while it is still dereferenced, git records mode 100644 and
 * the symlink is DEAD in the repo. After that, edits to the claude_business
 * master silently stop propagating and the chatbot serves stale product
 * knowledge — with no error anywhere. This has already happened three times
 * (see `git log --oneline -- docs/products.md`, which contains two separate
 * "Restore docs/products.md as symlink" commits).
 *
 * This checks the git INDEX, not the working tree, because the index is what a
 * commit actually records. A dereferenced working tree mid-deploy is fine and
 * expected; committing it is not.
 *
 * Usage:  node scripts/check-symlinks.mjs        (exit 1 on violation)
 * Wired into: .git/hooks/pre-commit and `npm run check:symlinks`
 */
import { execSync } from 'node:child_process'

/** Paths that must always be committed with git mode 120000 (symlink). */
const MUST_BE_SYMLINK = ['docs/products.md']

const GIT_MODE_SYMLINK = '120000'
let failed = false

for (const path of MUST_BE_SYMLINK) {
  let entry
  try {
    entry = execSync(`git ls-files -s -- "${path}"`, { encoding: 'utf-8' }).trim()
  } catch {
    continue // not tracked in this checkout — nothing to guard
  }
  if (!entry) continue

  const mode = entry.split(/\s+/)[0]
  if (mode !== GIT_MODE_SYMLINK) {
    failed = true
    console.error(`\n✖ ${path} is staged as a REAL FILE (mode ${mode}), not a symlink.`)
    console.error(`  Committing this kills the symlink to the claude_business master, after`)
    console.error(`  which product-knowledge edits silently stop reaching the chatbot.`)
    console.error(`\n  This almost always means a deploy dereferenced it and never restored it.`)
    console.error(`  Fix:  git checkout ${path}\n`)
  }
}

if (failed) {
  console.error('Commit blocked by scripts/check-symlinks.mjs\n')
  process.exit(1)
}
