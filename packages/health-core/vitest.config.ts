import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // See the root vitest.config.ts: a `process.env.TZ` pin only takes effect in
    // the `forks` pool, where the test file runs in its own child process.
    pool: 'forks',
  },
});
