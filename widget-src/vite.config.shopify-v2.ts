import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

// Phase 5: the v2 LOCAL-FIRST app built for the Shopify DEV theme extension
// (extensions-dev/health-plan-v2). Same standalone entry + api→shim redirect
// as the Pages build — only the packaging differs:
//  - ES module with FIXED file names (Shopify asset_url can't follow vite
//    content hashes). The lazy HistoryPanel chunk resolves relative to the
//    importing module's CDN URL, so code-splitting still works.
//  - No sourcemaps to the public theme (matches the Pages posture).
// Deploys ONLY with `shopify app deploy -c dev` (the prod config doesn't list
// extensions-dev/) — the live widget cannot pick this up by accident.
let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  /* not a git checkout */
}

const SHIM = resolve(__dirname, 'src/lib/roadmap-data.ts');
const REAL_API = /\/widget-src\/src\/lib\/api\.ts$/;

// NOTE: unlike the Pages/self-host build, the Shopify v2 build does NOT swap
// the AI transports for BYOK. This page runs on drstanfield.com, where the
// store's app proxy (/apps/health-tool-1 → Fly) is live: chat goes through
// Brad's server (chat-api → app proxy → chat.server.ts, Brad pays) and uploads
// go through upload-api → the Fly lab-import endpoint. Storefront = Brad pays
// for AI; only the storage layer swaps to local-first (api.ts → roadmap-data).
// VITE_LOCAL_FIRST=true tells the chat plumbing the user's plan lives client-
// side (their cloud, not our DB), so the client always sends it as chat context
// even though the app flags itself "logged in" for storage. See HealthTool +
// chat-api sendMessage + api.chat.ts (treatAsGuest).
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
  plugins: [redirectApiToLocalFirst(), react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.VITE_GIT_HASH': JSON.stringify(gitHash),
    'import.meta.env.VITE_LOCAL_FIRST': JSON.stringify('true'),
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
  build: {
    outDir: resolve(__dirname, '../extensions-dev/health-plan-v2/assets'),
    emptyOutDir: false, // assets dir also holds the upload bundle
    sourcemap: false,
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
