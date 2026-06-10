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
const BYOK_CHAT = resolve(__dirname, 'src/lib/byok-chat.ts');
const REAL_CHAT_API = /\/widget-src\/src\/lib\/chat-api\.ts$/;

function redirectApiToLocalFirst(): Plugin {
  return {
    name: 'redirect-api-to-local-first',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || importer.includes('/lib/roadmap-data')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved && REAL_API.test(resolved.id)) return SHIM;
      if (resolved && REAL_CHAT_API.test(resolved.id) && !importer.includes('/lib/byok-chat')) {
        return BYOK_CHAT;
      }
      return null;
    },
  };
}

export default defineConfig({
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
