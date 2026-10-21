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
| cold | 1Password only | `9a415581b0a54dbd` |
| ci | GitHub `engine-signing` environment secret only | `d6a343128471bae8` |

**Do now (Brad):** the cold key's private half is in
`~/.config/health-roadmap/engine-signing-key-COLD-move-to-1password.txt` (mode 0600).
Copy its one line into a 1Password item "Health Roadmap engine signing key (cold)",
then `rm -P` that file. The ci key's private half is in
`~/.config/health-roadmap/engine-signing-key-CI-move-to-github-secret.txt` (0600): paste
its one line as the `ENGINE_SIGNING_KEY` secret of the `engine-signing` environment
(below), then `rm -P` that file. No agent has seen either. The daily key stays only in
your Keychain.

- **Moving to another Mac:** on the old Mac, in Terminal (macOS asks you to allow the read),
  `/usr/bin/security find-generic-password -s health-roadmap-engine-signing -a daily -w`.
  Put the line it prints in a 1Password item "Health Roadmap engine signing key (daily)".
  On the new Mac:
  `/usr/bin/security add-generic-password -s health-roadmap-engine-signing -a daily -T "" -w`
  and paste the line when it asks (typed there, it stays out of your shell history).
  Run both yourself; never paste the line into a chat.
- **Lost Mac or Keychain:** build for the cold key, then sign with it in the signer
  only, so the key never reaches the build:
  `npm run engine:build -- --if-changed --key cold`, then
  `ENGINE_SIGNING_KEY='<cold line from 1Password>' node ios/scripts/sign-engine.mjs --key cold`.
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

## Automatic on push to main (for you to paste; agents never edit workflows)

Once pasted, each successful Deploy on `main` builds the engine with no secret and
uploads it as an artifact. A second job, `verify`, runs no repo code and no npm: it
downloads that artifact and writes its manifest, its sha256s and the engine source log
and diffstat (from a fresh checkout at the built commit) into its run summary (review
N2). Read that summary, then approve the third job, gated by a separate
`engine-signing` environment. It runs no repo code either: it checks the same artifact,
signs it with openssl and the ci key, and commits only the new files.

Set up first, in Settings, Environments, New environment `engine-signing`:
- Required reviewers: you.
- Deployment branches and tags: **Selected branches, `main` only**.
- Secret `ENGINE_SIGNING_KEY` = the ci key's line (its own pinned key, so the daily key
  never leaves your Keychain). If the ci key leaks, remove it from the pins in an app
  update; the other two keep working.

```yaml
# .github/workflows/engine-release.yml
name: Engine release
on:
  workflow_run:
    workflows: [Deploy]
    types: [completed]
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
concurrency: engine-release
jobs:
  build:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    outputs:
      changed: ${{ steps.release.outputs.changed }}
      bridge: ${{ steps.release.outputs.bridge }}
      sha: ${{ steps.release.outputs.sha }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci --ignore-scripts
      - id: release
        name: Build the release, unsigned (no secret in this job)
        run: |
          set -euo pipefail
          bridge=$(sha256sum ios/engine/bridge-contract.json | cut -c1-16)
          mkdir -p release-out
          [ -d "ios/engine-release/bridge-$bridge" ] && cp -R "ios/engine-release/bridge-$bridge" release-out/
          node ios/scripts/release-engine.mjs --key ci --if-changed --out release-out
          echo "bridge=$bridge" >> "$GITHUB_OUTPUT"
          echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
          if diff -r "ios/engine-release/bridge-$bridge" "release-out/bridge-$bridge" >/dev/null 2>&1; then
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi
      - if: steps.release.outputs.changed == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: engine-release
          path: release-out/bridge-${{ steps.release.outputs.bridge }}
  verify:
    # No repo code and no npm: what Brad reads before approving `sign` comes from here.
    needs: build
    if: needs.build.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.build.outputs.sha }}
          fetch-depth: 0
      - uses: actions/download-artifact@v4
        with:
          name: engine-release
          path: built
      - name: What will be signed (read this before approving)
        run: |
          set -euo pipefail
          last=$(git log -1 --format=%H -- ios/engine-release || true)
          {
            echo "## Engine release for bridge ${{ needs.build.outputs.bridge }}, built from ${{ needs.build.outputs.sha }}"
            echo '```json'; cat built/manifest.json; echo; echo '```'
            echo '```'; sha256sum built/*; echo '```'
            echo "### Engine source changed since the last release (${last:-none})"
            echo '```'
            [ -n "$last" ] && git log --oneline "$last"..HEAD -- packages/health-core/src ios/engine
            [ -n "$last" ] && git diff --stat "$last" HEAD -- packages/health-core/src ios/engine
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
  sign:
    needs: [build, verify]
    if: needs.build.outputs.changed == 'true'
    runs-on: ubuntu-latest
    environment: engine-signing
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
      - uses: actions/download-artifact@v4
        with:
          name: engine-release
          path: built
      - name: Check the artifact is what the build declared
        run: |
          set -euo pipefail
          test "$(jq -r .bridge built/manifest.json)" = "${{ needs.build.outputs.bridge }}"
          test "$(jq -r .keyId built/manifest.json)" = ci
          js="built/$(jq -r .sha256 built/manifest.json).js"
          test "$(sha256sum "$js" | cut -c1-64)" = "$(jq -r .sha256 built/manifest.json)"
          test "$(stat -c %s "$js")" = "$(jq -r .size built/manifest.json)"
          rm -f built/manifest.sig
      - name: Sign with the ci key (inline; no repo code runs here)
        env:
          ENGINE_SIGNING_KEY: ${{ secrets.ENGINE_SIGNING_KEY }}
        run: |
          set -euo pipefail
          umask 077
          key=$(mktemp); der=$(mktemp)
          { printf '\x30\x2e\x02\x01\x00\x30\x05\x06\x03\x2b\x65\x70\x04\x22\x04\x20'; printf '%s' "$ENGINE_SIGNING_KEY" | base64 -d; } > "$der"
          openssl pkey -inform DER -in "$der" -out "$key"
          { printf 'health-roadmap-engine-manifest/v1\n'; cat built/manifest.json; } > signed.tmp
          openssl pkeyutl -sign -inkey "$key" -rawin -in signed.tmp | base64 -w0 > built/manifest.sig
          echo >> built/manifest.sig
          shred -u "$key" "$der"; rm signed.tmp
      - name: Commit the release (add files only; never lower or replace a newer release)
        run: |
          set -euo pipefail
          dest="ios/engine-release/bridge-${{ needs.build.outputs.bridge }}"
          new=$(jq -r .version built/manifest.json)
          if [ -f "$dest/manifest.json" ] && [ "$(jq -r .version "$dest/manifest.json")" -ge "$new" ]; then
            echo "main already has release $(jq -r .version "$dest/manifest.json"), not older than $new: nothing to commit"; exit 0
          fi
          mkdir -p "$dest"
          cp built/*.js "$dest/"
          cp built/manifest.json built/manifest.sig "$dest/"
          git add "$dest"
          git -c user.name="Brad Stanfield" -c user.email="<your GitHub noreply address>" commit -m "Engine release $new (built from ${{ needs.build.outputs.sha }}, signed in CI)"
          git push origin HEAD:main
```

Pin the four actions to commit SHAs when you paste it, as the other workflows do. The
build job installs with `--ignore-scripts` and never sees the key. `verify` and `sign`
run no repo code and no npm: `verify` only reads the artifact and the git history, and
`sign` sees the key and runs only `jq`, `openssl`, `base64` and `git`. Both use the one
artifact the build uploaded, built from the commit named in the summary, never a fresh
build or a checkout of `main`. If `main` moved and
the push is refused, run it again. Old bundles stay in the folder; the app reads only
the one its manifest names.
