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
const BYOK_CHAT = resolve(__dirname, 'src/lib/byok-chat.ts');
const REAL_CHAT_API = /\/widget-src\/src\/lib\/chat-api\.ts$/;
const BYOK_UPLOAD = resolve(__dirname, 'src/lib/byok-upload.ts');
const REAL_UPLOAD_API = /\/widget-src\/src\/lib\/upload-api\.ts$/;

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
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      if (REAL_API.test(resolved.id) && !importer.includes('/lib/roadmap-data')) return SHIM;
      // Same swap for the chat transport: chat-api.ts (Shopify proxy) →
      // byok-chat.ts (direct browser → Anthropic with the user's own key).
      if (REAL_CHAT_API.test(resolved.id) && !importer.includes('/lib/byok-chat')) return BYOK_CHAT;
      // And the upload transport: upload-api.ts (Brad's Fly endpoint) →
      // byok-upload.ts (user's own key). The Shopify v2 build keeps upload-api.
      if (REAL_UPLOAD_API.test(resolved.id) && !importer.includes('/lib/byok-upload')) return BYOK_UPLOAD;
      return null;
    },
  };
}

export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? '/roadmap/',
  root: resolve(__dirname, 'standalone'),
  plugins: [redirectApiToLocalFirst(), react()],
  // Local dev server (`npm run dev:pages`) for rapid iteration with HMR. Port is
  // pinned + strict so the Dropbox OAuth redirect URI stays stable at
  // http://localhost:5173/roadmap/ — register that in the Dropbox app's list.
  server: { port: 5173, strictPort: true },
  define: {
    // 'production' for the static build; 'development' under `vite` serve so
    // React Fast Refresh and dev warnings work while iterating locally.
    'process.env.NODE_ENV': JSON.stringify(command === 'serve' ? 'development' : 'production'),
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
}));
