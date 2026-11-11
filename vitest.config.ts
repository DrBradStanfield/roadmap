import { defineConfig } from "vitest/config";
import { realpathSync } from "node:fs";
import { inCI, workerCap } from "./scripts/test-workers.mjs";

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
  // A session worktree's node_modules is a link to its own package clone, outside the repo (docs/git-workflow.md).
  // Vite resolves it to that real path, outside this root, and refuses a `?raw` import from there ("Denied ID",
  // widget-src/src/upload-entry.test.ts), so allow the real folder beside the root (the same path without a link).
  server: {
    fs: {
      allow: [
        new URL('.', import.meta.url).pathname,
        realpathSync(new URL('./node_modules', import.meta.url).pathname),
      ],
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
    // US-71 AC5: every local run, targeted ones included, takes test:all's cap (max(2, cpus/4), TEST_ALL_MAX_WORKERS), so
    // sessions testing at once cannot each fork a worker per core. A --maxWorkers flag still wins; CI is unchanged.
    maxWorkers: inCI() ? undefined : Number(workerCap()),
    // A fixed language for every test, so a runner in a US time zone does not switch the widget to US units.
    setupFiles: ['./tests/setup-locale.ts'],
    // Vitest 4 fails a synchronous test that overruns testTimeout; 1.6 let it
    // finish. Several exhaustive sweeps (units, medication-cascades) and the
    // spawnSync-driven codex-review suites take 5-45 s when the full suite loads
    // every core, so the default 5 s would fail them by machine load alone.
    testTimeout: 60_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-pages/**",
      "**/build/**",
      "**/.react-router/**",
      "**/.claude/**",
      "**/.stryker-tmp*/**",
    ],
    server: {
      deps: {
        inline: [/@sentry\/react-router/, /@opentelemetry\//],
      },
    },
  },
});
