#!/usr/bin/env node
// Builds an over-the-air engine release, unsigned (ios/architecture.md D3, US-25 AC18):
//   npm run engine:build -- --if-changed [--min-version V]   (runs: env -u ENGINE_SIGNING_KEY node ios/scripts/release-engine.mjs)
//   node ios/scripts/sign-engine.mjs                          (then sign, run directly)
// This first module only checks that no signing key is in the environment, and refuses
// if one is (review N3). Only then does it load the build code (release-build.mjs), so
// no module that runs repo code ever shares a process with a key.
if (process.env.ENGINE_SIGNING_KEY !== undefined) {
  console.error('Refusing to build with ENGINE_SIGNING_KEY in the environment: the build runs repo code. Run it as `env -u ENGINE_SIGNING_KEY node ios/scripts/release-engine.mjs`, then sign with `node ios/scripts/sign-engine.mjs`.');
  process.exit(1);
}
await import('./release-build.mjs');
