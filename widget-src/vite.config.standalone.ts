import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

// Standalone static build for GitHub Pages / self-host (front door B).
//   index.html → the full Health Roadmap app (Phase 1+), local-first storage
//   test.html  → the storage self-test + live Dropbox round-trip (Phase 0 harness)
//
// base '/roadmap/' targets https://drbradstanfield.github.io/roadmap/.
let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  /* not a git checkout */
}

const SHIM = resolve(__dirname, 'src/lib/roadmap-data.ts');
const REAL_API = /\/widget-src\/src\/lib\/api\.ts$/;

/**
 * Redirect every import that resolves to `src/lib/api.ts` to the local-first
 * shim — EXCEPT the shim's own `export * from './api'`. This swaps the data
 * layer for the standalone build only; the live Shopify widget's source is
 * untouched (it keeps using the real api.ts), so it can't break before cutover.
 */
function redirectApiToLocalFirst(): Plugin {
  return {
    name: 'redirect-api-to-local-first',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || importer.includes('/lib/roadmap-data')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved && REAL_API.test(resolved.id)) return SHIM;
      return null;
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE ?? '/roadmap/',
  root: resolve(__dirname, 'standalone'),
  plugins: [redirectApiToLocalFirst(), react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.VITE_GIT_HASH': JSON.stringify(gitHash),
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-pages'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'standalone/index.html'),
        test: resolve(__dirname, 'standalone/test.html'),
      },
    },
  },
});
