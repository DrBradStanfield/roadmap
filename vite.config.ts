import { existsSync, readFileSync } from "node:fs";
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

// Externalized packages that list react-router as a dep/peer but are VERIFIED
// safe to leave external (the guard plugin below skips them):
//  - @sentry/react-router: its server build never does a runtime
//    `import "react-router"` (only string constants), AND it MUST stay external —
//    instrument.server.mjs (`node --import`) initializes the node_modules copy
//    before the bundle loads, so inlining it would create a second, uninitialized
//    SDK instance and silently break server error reporting.
const REACT_ROUTER_SAFE_EXTERNALS = new Set(["@sentry/react-router"]);

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function packageListsReactRouter(pkgName: string): boolean {
  try {
    const pkg = JSON.parse(
      readFileSync(
        new URL(`./node_modules/${pkgName}/package.json`, import.meta.url),
        "utf8",
      ),
    );
    return Boolean(
      pkg.dependencies?.["react-router"] ?? pkg.peerDependencies?.["react-router"],
    );
  } catch {
    return false; // not a package (node builtin, chunk filename) — irrelevant
  }
}

// Build-time guard for the invariant above: FAIL the SSR build if the emitted
// server bundle still contains an external import of react-router itself or of
// any package that declares react-router as a dependency/peer. Such an import
// re-resolves at runtime to dist/development — a second react-router instance —
// and recreates the useNavigate-Router-context crash. Client chunks are fully
// bundled (no bare external specifiers), so this is a natural no-op there.
function assertNoExternalReactRouterConsumers() {
  return {
    name: "assert-no-external-react-router-consumers",
    generateBundle(_options: unknown, bundle: Record<string, any>) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const spec of [...chunk.imports, ...chunk.dynamicImports]) {
          if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
          const pkgName = packageNameOf(spec);
          if (REACT_ROUTER_SAFE_EXTERNALS.has(pkgName)) continue;
          if (pkgName === "react-router" || packageListsReactRouter(pkgName)) {
            this.error(
              `Server bundle chunk "${chunk.fileName}" externally imports "${spec}", ` +
                `which resolves react-router to dist/development at runtime — a second ` +
                `react-router instance that crashes SSR (useNavigate Router-context ` +
                `invariant; Sentry issue 7598495822). Add "${pkgName}" to ssr.noExternal ` +
                `(if it imports react-router at runtime) or to REACT_ROUTER_SAFE_EXTERNALS ` +
                `in vite.config.ts (only after verifying its server build never does a ` +
                `runtime \`import "react-router"\`).`,
            );
          }
        }
      }
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
    assertNoExternalReactRouterConsumers(),
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
    //
    // Every OTHER package in the SSR graph that itself imports `react-router` at
    // runtime must ALSO be inlined, or its import re-resolves through the package
    // exports to dist/development — a SECOND react-router instance whose hooks
    // can't see the inlined copy's <Router> context. That's exactly what broke
    // every embedded admin page after the original fix: externalized
    // @shopify/shopify-app-react-router's AppProvider/AppBridge called the dev
    // copy's useNavigate() during SSR → "may be used only in the context of a
    // <Router>" → Unexpected Server Error (Sentry issue 7598495822).
    //
    //  - @shopify/shopify-app-react-router: renders React (AppProvider/AppBridge,
    //    Link) inside our Router tree — MUST share the inlined instance.
    //  - @react-router/node: no React rendering, but its module top-level does
    //    `import "react-router"`, which would still load the dev copy into the
    //    process; inlining routes it through the same production redirect.
    // (@react-router/serve + /express run OUTSIDE the vite bundle as the runtime
    // server; they only do data-plane request handling — never create React
    // elements — so their own react-router copy can't clash with render context.
    // @sentry/react-router's server build has no runtime react-router import.)
    //
    // This list is enforced: assertNoExternalReactRouterConsumers() (above) fails
    // the build if a future dep leaves an external react-router consumer in the
    // server bundle, so a regression can't ship silently.
    noExternal: [
      "react-router",
      "@shopify/shopify-app-react-router",
      "@react-router/node",
    ],
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}) satisfies UserConfig);
