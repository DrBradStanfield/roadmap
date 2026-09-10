import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve the package's OWN name to src, exactly like the root config does.
  // The parity test imports widget-src/src/lib/sentry, which imports
  // `@roadmap/health-core`; without this it resolves to the gitignored, stale
  // dist/ and the suite fails with "scrubEventText is not a function".
  resolve: {
    alias: {
      '@roadmap/health-core': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // See the root vitest.config.ts: a `process.env.TZ` pin only takes effect in
    // the `forks` pool, where the test file runs in its own child process.
    pool: 'forks',
  },
});
