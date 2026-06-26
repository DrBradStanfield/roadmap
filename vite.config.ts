import { existsSync } from "node:fs";
import { reactRouter } from "@react-router/dev/vite";
import { sentryReactRouter, type SentryReactRouterBuildOptions } from "@sentry/react-router";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Replace the HOST env var with SHOPIFY_APP_URL so that it doesn't break the Vite server.
// The CLI will eventually stop passing in HOST, so we can remove this workaround after
// the next major release.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT!) || 8002,
    clientPort: 443,
  };
}

// Sentry source-map upload runs only when an auth token is present (local deploy
// step / CI / the Fly Docker build's --build-secret). Without it the upload is
// disabled outright so local + Fly builds stay green instead of erroring on a
// missing org / undefined release.
//
//  - org/project come from SENTRY_ORG/PROJECT (non-secret slugs; on Fly they're
//    baked as Dockerfile build ARGs from fly.toml's [build.args]).
//  - release.name comes from SENTRY_RELEASE — set EXPLICITLY (not just via env)
//    because the RR7 `sentryOnBuildEnd` pass reads release only from this config
//    object (it would otherwise upload with `--release undefined`), and because
//    node:22-alpine has no git CLI so the plugin can't auto-detect HEAD's SHA in
//    the container. On Fly it's passed at deploy time via --build-arg.
//  - `disable` is set at the TOP-LEVEL `sourcemaps` (not under
//    unstable_sentryVitePluginOptions) because that's the key `sentryOnBuildEnd`
//    actually reads for its disable check — keeping the no-op honored on the
//    final RR7 upload pass too.
//
// .env is .dockerignore'd, so on Fly these all arrive via build args / a build
// secret, never from a copied .env. See CLAUDE.md Sentry + Deploy Workflow.
const hasSentryUpload = !!process.env.SENTRY_AUTH_TOKEN;
const sentryConfig: SentryReactRouterBuildOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: { name: process.env.SENTRY_RELEASE },
  // Hidden source maps: uploaded to Sentry, never shipped to the client bundle.
  sourcemaps: {
    disable: !hasSentryUpload,
    filesToDeleteAfterUpload: ["**/*.map"],
  },
};

// react-router 7.17.0 ships a PRODUCTION dist (dist/production/*, stripped of dev
// warnings/invariants) but its package.json `exports` has NO development/production
// condition — every condition (node/import/module/default) points at
// dist/development/index.mjs. So when react-router is externalized (the vite SSR
// default), the running server resolves `import "react-router"` to the DEV build no
// matter what NODE_ENV / --conditions are (verified: NODE_ENV=production +
// --conditions=production still resolve dist/development). That's why prod Sentry
// frames showed react-router/dist/development/chunk-*.mjs.
//
// Fix (server build only): bundle react-router into the SSR output (ssr.noExternal)
// and redirect the bare specifier to the production entry. The client build already
// gets the production build, so we scope the redirect to options.ssr and leave the
// client untouched. Exact-match `react-router` only — sub-paths like `react-router/dom`
// keep their normal resolution.
const reactRouterProdEntry = new URL(
  "./node_modules/react-router/dist/production/index.mjs",
  import.meta.url,
).pathname;
// Guard: if a future react-router version drops/relocates dist/production, fall
// through to normal resolution rather than redirecting to a missing file.
const reactRouterProdEntryExists = existsSync(reactRouterProdEntry);

function reactRouterServerProductionBuild() {
  return {
    name: "react-router-server-production-build",
    enforce: "pre" as const,
    resolveId(id: string, _importer: string | undefined, options?: { ssr?: boolean }) {
      if (options?.ssr && id === "react-router" && reactRouterProdEntryExists) {
        return reactRouterProdEntry;
      }
      return null;
    },
  };
}

export default defineConfig((config) => ({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // See https://vitejs.dev/config/server-options.html#server-fs-allow for more information
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    reactRouterServerProductionBuild(),
    reactRouter(),
    sentryReactRouter(sentryConfig, config),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  ssr: {
    // Bundle react-router into the server output so the resolveId redirect above
    // (to dist/production/index.mjs) is actually inlined instead of left as a
    // runtime `import "react-router"` that re-resolves to dist/development.
    noExternal: ["react-router"],
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}) satisfies UserConfig);
