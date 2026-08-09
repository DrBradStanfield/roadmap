#!/usr/bin/env node
/**
 * Guard: docs/products.md is the MASTER copy and must be a REAL committed file.
 *
 * Why this exists (direction INVERTED 2026-08-10, Brad's call)
 * -----------------------------------------------------------
 * Until 2026-08-10 the master lived in claude_business (Dropbox) and this repo
 * held a symlink — which made every Fly deploy do a dereference/restore dance
 * and made headless (CI) deploys impossible: the Docker build baked in whatever
 * the symlink resolved to, i.e. nothing on any machine but Brad's Mac.
 *
 * Now the MASTER lives HERE as a real tracked file, and claude_business holds
 * the symlink pointing back at this repo. If a commit ever records
 * docs/products.md as a symlink again (mode 120000), the repo — and therefore
 * every Fly image and CI deploy — loses the product knowledge content, and the
 * chatbot silently degrades with no error anywhere.
 *
 * This checks the git INDEX, because the index is what a commit records.
 *
 * Usage:  node scripts/check-symlinks.mjs        (exit 1 on violation)
 * Wired into: .git/hooks/pre-commit and `npm run check:symlinks`
 */
import { execSync } from 'node:child_process'

/** Paths that must always be committed as REAL files (git mode 100644). */
const MUST_BE_REAL_FILE = ['docs/products.md']

const GIT_MODE_SYMLINK = '120000'
let failed = false

for (const path of MUST_BE_REAL_FILE) {
  let entry
  try {
    entry = execSync(`git ls-files -s -- "${path}"`, { encoding: 'utf-8' }).trim()
  } catch {
    continue // not tracked in this checkout — nothing to guard
  }
  if (!entry) continue

  const mode = entry.split(/\s+/)[0]
  if (mode === GIT_MODE_SYMLINK) {
    failed = true
    console.error(`\n✖ ${path} is staged as a SYMLINK (mode ${mode}), not a real file.`)
    console.error(`  This repo holds the MASTER copy (since 2026-08-10); committing a symlink`)
    console.error(`  strips the content out of every Fly image and CI deploy — the chatbot`)
    console.error(`  silently loses its product knowledge.`)
    console.error(`\n  If you meant to edit product content, edit the real file here directly.`)
    console.error(`  (claude_business/docs/products.md is now the symlink, pointing HERE.)\n`)
  }
}

if (failed) {
  console.error('Commit blocked by scripts/check-symlinks.mjs\n')
  process.exit(1)
}
