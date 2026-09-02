import { defineConfig } from "vitest/config";

// Root vitest config for the server (`app/`) + workspace test runs.
//
// Two things changed with the React Router 7 / @sentry/react-router migration that this
// config addresses:
//
// 1. @sentry/react-router pulls in @opentelemetry/* packages whose ESM entrypoints use
//    bare directory imports (e.g. `./trace`). Node's native ESM resolver rejects those
//    (ERR_UNSUPPORTED_DIR_IMPORT) when a tested `*.server.ts` module imports Sentry. Vite's
//    bundler handles them fine, so we inline the Sentry + OTel deps to route them through
//    Vite's transform instead of Node's resolver.
//
// 2. `react-router typegen` writes generated stub files under `.react-router/types/**`,
//    including mirror `*.test.ts` files that aren't real suites. Exclude that dir so vitest
//    doesn't try to run them.
export default defineConfig({
  // Resolve the workspace package to its SOURCE, exactly like the widget vite
  // configs do. Without this, tests import dist/ — which is gitignored, never
  // built in CI (test:all went red the first time a widget test imported the
  // package name), and goes silently stale locally after any src edit.
  resolve: {
    alias: {
      '@roadmap/health-core': new URL('./packages/health-core/src', import.meta.url).pathname,
    },
  },
  test: {
    // The whole suite runs in `forks`. `process.env.TZ = ...` at the top of a test
    // file is a no-op in the default `threads` pool — a worker thread inherits a COPY
    // of the environment and node never calls tzset for it — so the TZ-pinned
    // `*-local-day` suites need a real child process. Routing them by glob was
    // path-dependent: micromatch `**` skips dot segments, so a `.claude/worktrees/`
    // checkout ran them in threads and quietly failed. Forks for everything removes the
    // trap, is faster here, and `poolMatchGlobs` is gone in vitest 3.
    pool: 'forks',
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-pages/**",
      "**/build/**",
      "**/.react-router/**",
      "**/.claude/**",
    ],
    server: {
      deps: {
        inline: [/@sentry\/react-router/, /@opentelemetry\//],
      },
    },
  },
});
