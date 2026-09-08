import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

// The LOCAL-FIRST production Shopify widget, built straight into the
// production theme extension (extensions/health-tool-widget/assets). Same
// standalone entry and local-first data layer as the Pages build — only the
// packaging differs:
//  - ES module with FIXED file names (Shopify asset_url can't follow vite
//    content hashes). The lazy HistoryPanel chunk resolves relative to the
//    importing module's CDN URL, so code-splitting still works.
//  - Hidden sourcemaps: .map files ARE emitted (so Sentry can symbolicate via
//    debug IDs) but the shipped .js carries NO //# sourceMappingURL comment, so
//    nothing is referenced/leaked publicly. The deploy workflow uploads the maps
//    to Sentry then strips them before `shopify app deploy` (10MB limit).
// Deploys with `npx shopify app deploy --force` (production app).
let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  /* not a git checkout */
}

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.VITE_GIT_HASH': JSON.stringify(gitHash),
    'import.meta.env.VITE_LOCAL_FIRST': JSON.stringify('true'),
    // Distinguishes the drstanfield.com (Shopify) local-first surface from the
    // Pages/self-host one: Shopify-only features (guest report email through
    // the app proxy — Brad's server) gate on this. The Pages build never
    // defines it, so those features stay off there.
    'import.meta.env.VITE_SHOPIFY_SURFACE': JSON.stringify('true'),
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
  build: {
    outDir: resolve(__dirname, '../extensions/health-tool-widget/assets'),
    emptyOutDir: false, // assets dir also holds the upload bundle
    sourcemap: 'hidden',
    rollupOptions: {
      input: resolve(__dirname, 'standalone/app.tsx'),
      output: {
        format: 'es',
        entryFileNames: 'health-plan-v2.js',
        chunkFileNames: 'health-plan-v2-[name].js',
        assetFileNames: 'health-plan-v2.[ext]',
      },
    },
  },
});
