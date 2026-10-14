import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // See the root vitest.config.ts: a `process.env.TZ` pin only takes effect in
    // the `forks` pool, where the test file runs in its own child process.
    pool: 'forks',
    // See the root vitest.config.ts: vitest 4 times out long synchronous sweeps.
    testTimeout: 60_000,
  },
});
