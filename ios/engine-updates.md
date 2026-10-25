# Engine updates over the air: how to release

For Brad. The design and its reasons are in [architecture.md](architecture.md) D3; the
story is US-25 AC18. This page is the how-to.

A fix to health-core reaches installed iPhones without an App Store release. Phones
read `ios/engine-release/` from `main` on GitHub, but they run a release only if one of
your keys signed it. A push to `main` without a signature, from a loop or anyone else,
changes nothing on a phone. **A signature means "the key holder approved this
bundle". Nothing more.** Sign only what you would ship.

## Release from your Mac (the path today)

Two steps, so no repo code ever runs next to a key (review R1, N3, N4): the build runs
esbuild and the parity check and never holds a key; the signer runs no repo code.

1. Commit the engine change (health-core or `ios/engine`) and `git pull --ff-only`.
2. `npm run engine:release` (the same as `npm run engine:build -- --if-changed`)
   - It runs `env -u ENGINE_SIGNING_KEY node ios/scripts/release-engine.mjs`, whose
     first module refuses to go on if a key is in its environment; only then does it
     load the build code.
   - It builds the engine, checks it against the source on every parity fixture, and
     writes `ios/engine-release/bridge-<id>/`: the bundle as `<sha256>.js` and
     `manifest.json`, unsigned. Its last line names the sign command.
   - `--if-changed` stops with "nothing to release" when the engine is unchanged.
   - It refuses uncommitted engine source and a second release in the same minute.
   - Build options go after `--`, on the build command only:
     `npm run engine:build -- --if-changed --min-version <v>`.
3. `node ios/scripts/sign-engine.mjs`: run it directly, never through `npm run` (npm
   runs lifecycle scripts and puts the repo's tools first on PATH).
   - It reads the manifest and bundle from disk, checks them (canonical, this bridge,
     the hash), and signs with the daily key, read with `/usr/bin/security` by its
     absolute path.
   - macOS asks: *security wants to use your confidential information stored in
     "health-roadmap-engine-signing" in your keychain.* Type your login password and
     click **Allow**. Never **Always Allow**: that would let any script read the key
     without asking.
4. `git add ios/engine-release && git commit -m "Engine release <version>" && git pull --ff-only && git push`

Phones see a release the next time the app comes on screen (at most one check in 6
hours) and run it from the launch after that. Build options: `--min-version <v>` raises
the floor, so no phone runs anything older (use it to kill a bad release);
`--min-app-build <n>` keeps a release from app builds too old for it. The floor and the
highest version each phone accepted also live in its Keychain, so a damaged state
file on the phone cannot lower them.

**What only an app update can change** (the app refuses these in a download): the
native bridge (`ios/engine/bridge-contract.json`: its hash is the bridge id, and a new
bridge gets its own folder), the record schema version, and the pinned keys.

**Revocation needs the repo public.** Phones read releases from raw.githubusercontent.com
with no sign-in. If the repo goes private (as in September 2026), no phone can fetch a
new release, including one that raises the floor to kill a bad one. The fallback is an
App Store update: its bundled engine is newer, so phones delete older downloads.

## The keys

Made on 2026-10-22 by `ios/scripts/engine-keygen.mjs` (`--add ci` for the third). Public
keys: `ios/engine/signing-keys.json`, pinned in `EngineRelease.swift`.

| Key | Where | Fingerprint (SHA-256 of the public key, first 16 hex) |
|---|---|---|
| daily | login Keychain, service `health-roadmap-engine-signing`, account `daily`, trusted by no app | `519a8365b02da897` |
| cold | the Passwords app only | `9a415581b0a54dbd` |
| ci | GitHub `engine-signing` environment secret only | `d6a343128471bae8` |

**Do now (Brad): two steps, in Terminal.** No agent has seen either key; the daily
key stays only in your Keychain.

1. The ci key into GitHub, then delete its file (`gh` reads the file itself, so the
   line never reaches your screen or shell history):
   ```sh
   gh secret set ENGINE_SIGNING_KEY --env engine-signing < ~/.config/health-roadmap/engine-signing-key-CI-move-to-github-secret.txt && rm -P ~/.config/health-roadmap/engine-signing-key-CI-move-to-github-secret.txt
   ```
2. The cold key into the Passwords app, then delete its file. Open the file in
   TextEdit, copy its one line into a new entry in the Passwords app (iCloud Keychain)
   named "Health Roadmap engine signing key (cold)", save, quit TextEdit without saving,
   then:
   ```sh
   open -a TextEdit ~/.config/health-roadmap/engine-signing-key-COLD-move-to-1password.txt
   rm -P ~/.config/health-roadmap/engine-signing-key-COLD-move-to-1password.txt
   ```
   Run the `rm -P` only after the entry is saved: it is the only copy of the cold key.

- **Moving to another Mac:** on the old Mac, in Terminal (macOS asks you to allow the read),
  `/usr/bin/security find-generic-password -s health-roadmap-engine-signing -a daily -w`.
  Put the line it prints in an entry in the Passwords app (iCloud Keychain) "Health Roadmap engine signing key (daily)".
  On the new Mac:
  `/usr/bin/security add-generic-password -s health-roadmap-engine-signing -a daily -T "" -w`
  and paste the line when it asks (typed there, it stays out of your shell history).
  Run both yourself; never paste the line into a chat.
- **Lost Mac or Keychain:** build for the cold key, then sign with it in the signer
  only, so the key never reaches the build:
  `npm run engine:build -- --if-changed --key cold`, then
  `ENGINE_SIGNING_KEY='<cold line from the Passwords app>' node ios/scripts/sign-engine.mjs --key cold`.
  Then make a new daily key in an app update (below).
- **Rotate or revoke:** add the new public key under a new id to both
  `signing-keys.json` and `EngineRelease.publicKeys`, remove the old one, ship an app
  update. A phone re-checks every staged engine against its current pins at launch,
  so an engine signed by a removed key stops running there. A stolen key can sign
  versions at most two days past the phone's clock, so a release after that, from the
  new key, outranks anything it signed.
- `ios/scripts/signing-key-guard.test.ts` fails if a key-shaped file or a private key
  appears in any tracked file, and, while the cold and ci files are still on this Mac,
  if their bytes do.

## Automatic after a Deploy on main

The workflow is [`.github/workflows/engine-release.yml`](../.github/workflows/engine-release.yml),
added 2026-10-25 with Brad's permission. It does nothing useful until the ci key is
the `ENGINE_SIGNING_KEY` secret (step 1 above): before that, `sign` fails at the key
check and nothing is committed.

Each successful Deploy dispatched on `main` builds the engine with no secret and
uploads it as an artifact; the build job decides only whether there is anything to
upload. A second job, `verify`, runs no repo code and no npm. It takes the commit from
the Deploy event, computes the bridge itself and checks the artifact against them,
never reading the build job's other outputs, since that job ran repo code. Its run
summary shows the manifest, the sha256s and every file changed since the commit the
last release was built from (review N2). Read that summary,
then approve the third job, gated by the `engine-signing` environment. It runs no repo
code either: it checks the artifact again, signs it with openssl and the ci key, and
commits only the new files.

- **The environment, set up 2026-10-25:** `engine-signing`, required reviewer
  DrBradStanfield, deployment branches: `main` only. Secret `ENGINE_SIGNING_KEY` = the
  ci key's line (its own pinned key, so the daily key never leaves your Keychain); not
  set yet. If the ci key leaks, remove it from the pins in an app update; the other two
  keep working.
- **Which Deploys.** Only a Deploy dispatched on `main` (Actions, Deploy, Run
  workflow). A merged pull request's Deploy (event `pull_request`) never starts one;
  nor does a pull request from a fork whose branch is called `main`. auto-ship.yml
  dispatches Deploy with `--ref main`, so an auto-shipped Deploy passes the filter, but
  whether its completion fires this workflow is unverified (GitHub limits runs started
  by `GITHUB_TOKEN` and chains of `workflow_run`). Check the first one: if no Engine
  release ran, run Actions, Engine release, Run workflow on `main` by hand, after it and
  after any merged-PR Deploy.
- **Main moved.** A dispatched Deploy ships `main`'s tip, which may be newer than the
  commit the event names. If the engine's inputs (health-core, `ios/engine`,
  `ios/scripts`, the Xcode project file, `package.json`, `package-lock.json`, any
  `.npmrc` or `tsconfig*`) differ between the two, `verify` fails: "main moved since
  this Deploy; dispatch Engine release again". Do that. The sign job repeats the check
  against `main` after your approval, before it signs.
- **Read the summary before approving.** It shows `git diff --stat` and `git log
  --stat` with no path filter, from the commit the last CI release was built from (the
  `built-from` file the sign job writes beside the manifest; it is not signed and
  phones never read it). With no such file (a release from your Mac), the base is the
  last commit that touched `ios/engine-release`, and a warning says it is approximate.
  A warning line at the top also flags a first release, or a change to the build
  scripts, the Xcode project, a `package.json`, the lock file, an `.npmrc` or a
  `tsconfig`: those run in the build, so read their diffs. A summary over 1 MB is
  truncated, says so, and fails the job, so such a release cannot be approved.
- **The build job** installs with `npm ci --ignore-scripts`, runs
  `env -u ENGINE_SIGNING_KEY node ios/scripts/release-engine.mjs --key ci --if-changed`
  and never sees the key. `--if-changed` stops it when the engine is unchanged; then
  `verify` and `sign` are skipped.
- **The sign job** checks the shapes (bridge 16 hex digits, commit 40, bundle hash 64,
  versions 12 digits), that the artifact holds only `manifest.json` and its
  `<sha256>.js`, the canonical manifest, the bridge, `keyId` ci, the bundle's hash and
  size, and that `minVersion` is not below the floor already on `main`. It checks the
  secret is the pinned ci key, signs, verifies the signature, and refuses to commit
  over a release on `main` that is not older. Every check fails closed. It sees the key
  and runs only `jq`, `openssl`, `base64` and `git`, and copies only the bundle, the
  manifest and the signature, then writes `built-from`. The commit carries your name and GitHub noreply address.
- **Releases expire after 30 days for new installs.** A manifest's `notAfter` is 30 days
  after it was issued. A phone that already installed it keeps running it, but a phone
  that has not (a new install, or one offline for a month) refuses it and runs its
  bundled engine. If no engine change has shipped for about three weeks, re-issue: run
  Actions, Engine release, Run workflow on `main` with **reissue** ticked. It skips
  `--if-changed`, so the same engine gets a fresh 30-day manifest at a new version; if
  no artifact arrives, `verify` fails rather than skipping.
- **One queue for all runs** (`concurrency: engine-release`), whatever the ref: every
  run writes the same folder on `main`.
- Actions are pinned to commit SHAs; the workflow has no permissions by default, the
  build and `verify` read the repo, and only `sign` may write.
  `ios/scripts/engine-release-workflow.test.ts` holds these guards in place and signs a
  throwaway manifest with the sign job's own commands.
- **Accepted residual:** any session that uses your `gh` token (an agent on this Mac,
  say) can approve the `engine-signing` gate, or bypass it as an admin. The gate stops
  loops and other pushers, not a process holding your token. Approve releases from the
  GitHub web page only, never because a session asked you to run `gh`.
- If `main` moved and the push is refused, run it again. Old bundles stay in the
  folder; the app reads only the one its manifest names.
