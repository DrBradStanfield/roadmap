# Engine updates over the air: how to release

For Brad. The design and its reasons are in [architecture.md](architecture.md) D3; the
story is US-25 AC18. This page is the how-to.

A fix to health-core reaches installed iPhones without an App Store release. Phones
read `ios/engine-release/` from `main` on GitHub, but they run a release only if your
key signed it. A push to `main` without a signature, from a loop or anyone else,
changes nothing on a phone. **A signature means "the key holder approved this
bundle". Nothing more.** Sign only what you would ship.

## Release from your Mac (the path today)

1. Commit the engine change (health-core or `ios/engine`) and `git pull --ff-only`.
2. `npm run engine:release -- --if-changed`
   - It builds the engine, checks it against the source on every parity fixture, and
     writes `ios/engine-release/bridge-<id>/`: the bundle as `<sha256>.js`,
     `manifest.json` and `manifest.sig`.
   - macOS asks: *security wants to use your confidential information stored in
     "health-roadmap-engine-signing" in your keychain.* Type your login password and
     click **Allow**. Never **Always Allow**: that would let any script read the key
     without asking.
   - `--if-changed` stops with "nothing to release" when the engine is unchanged.
   - It refuses uncommitted engine source and a second release in the same minute.
3. `git add ios/engine-release && git commit -m "Engine release <version>" && git pull --ff-only && git push`

Phones see it the next time the app comes on screen (at most one check in 6 hours) and
run it from the launch after that. Options: `--min-version <v>` raises the floor, so no
phone runs anything older (use it to kill a bad release); `--min-app-build <n>` keeps a
release from app builds too old for it.

**What only an app update can change** (the app refuses these in a download): the
native bridge (`ios/engine/bridge-contract.json`: its hash is the bridge id, and a new
bridge gets its own folder), the record schema version, and the pinned keys.

## The keys

Made once on 2026-10-22 by `ios/scripts/engine-keygen.mjs`. Public keys:
`ios/engine/signing-keys.json`, pinned in `EngineRelease.swift`.

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

- **Lost Mac or Keychain:** sign with the cold key:
  `ENGINE_SIGNING_KEY='<cold line from 1Password>' npm run engine:release -- --key cold`.
  Then make a new daily key in an app update (below).
- **Rotate or revoke:** add the new public key under a new id to both
  `signing-keys.json` and `EngineRelease.publicKeys`, remove the old one, ship an app
  update. A phone re-checks every staged engine against its current pins at launch,
  so an engine signed by a removed key stops running there. A stolen key can sign
  versions at most two days past the phone's clock, so a release after that, from the
  new key, outranks anything it signed.
- `ios/scripts/signing-key-guard.test.ts` fails if a key-shaped file or a private key
  appears in any tracked file.

## Automatic on push to main (for you to paste; agents never edit workflows)

Once pasted, each successful Deploy on `main` builds the engine with no secret, and a
second job, gated by a separate `engine-signing` environment where you are the
required reviewer, shows what it will sign and signs it with inline steps only, so no
repo code runs next to the key. Set up first: Settings, Environments, New environment
`engine-signing`; Required reviewers: you; secret `ENGINE_SIGNING_KEY` = the ci key's
line (its own pinned key, so the daily key never leaves your Keychain). If the ci key
leaks, remove it from the pins in an app update; the other two keep working.

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
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - id: release
        name: Build the release, unsigned
        run: |
          mkdir -p release-out
          [ -d ios/engine-release ] && cp -R ios/engine-release/. release-out/
          node ios/scripts/release-engine.mjs --no-sign --key ci --if-changed --out release-out
          if diff -r ios/engine-release release-out >/dev/null 2>&1; then echo "changed=false" >> "$GITHUB_OUTPUT"; else echo "changed=true" >> "$GITHUB_OUTPUT"; fi
      - if: steps.release.outputs.changed == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: engine-release
          path: release-out
  sign:
    needs: build
    if: needs.build.outputs.changed == 'true'
    runs-on: ubuntu-latest
    environment: engine-signing
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0
      - uses: actions/download-artifact@v4
        with:
          name: engine-release
          path: release-out
      - name: Show what will be signed
        run: |
          for m in release-out/bridge-*/manifest.json; do echo "== $m"; cat "$m"; echo; done
          sha256sum release-out/bridge-*/*.js
          last=$(git log -1 --format=%H -- ios/engine-release || true)
          echo "== engine source changed since the last release ($last):"
          [ -n "$last" ] && git diff --stat "$last" HEAD -- packages/health-core/src ios/engine || true
      - name: Sign with the ci key (inline; no repo code runs here)
        env:
          ENGINE_SIGNING_KEY: ${{ secrets.ENGINE_SIGNING_KEY }}
        run: |
          set -euo pipefail
          umask 077
          key=$(mktemp); der=$(mktemp)
          { printf '\x30\x2e\x02\x01\x00\x30\x05\x06\x03\x2b\x65\x70\x04\x22\x04\x20'; printf '%s' "$ENGINE_SIGNING_KEY" | base64 -d; } > "$der"
          openssl pkey -inform DER -in "$der" -out "$key"
          for dir in release-out/bridge-*/; do
            [ -f "$dir/manifest.sig" ] && continue
            { printf 'health-roadmap-engine-manifest/v1\n'; cat "$dir/manifest.json"; } > "$dir/signed.tmp"
            openssl pkeyutl -sign -inkey "$key" -rawin -in "$dir/signed.tmp" | base64 -w0 > "$dir/manifest.sig"
            echo >> "$dir/manifest.sig"
            rm "$dir/signed.tmp"
          done
          shred -u "$key" "$der"
      - name: Commit the release
        run: |
          rsync -a --delete release-out/ ios/engine-release/
          git add ios/engine-release
          git -c user.name="Brad Stanfield" -c user.email="<your GitHub noreply address>" commit -m "Engine release (signed in CI)"
          git pull --rebase origin main
          git push origin HEAD:main
```

Pin the four actions to commit SHAs when you paste it, as the other workflows do. The
build job runs `npm ci` and the release script, but never sees the key; the sign job
sees the key and runs only `openssl`, `base64` and `git`.
