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
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-pages/**",
      "**/build/**",
      "**/.react-router/**",
    ],
    server: {
      deps: {
        inline: [/@sentry\/react-router/, /@opentelemetry\//],
      },
    },
  },
});
