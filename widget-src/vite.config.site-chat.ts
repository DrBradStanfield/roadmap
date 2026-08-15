import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

const gitHash = execSync('git rev-parse --short HEAD').toString().trim();
const release = `health-tool-widget@${gitHash}`;

// Site-wide chat bubble — separate IIFE bundle.
// Loaded on all pages except the roadmap (where HealthTool handles chat).
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    '__SENTRY_RELEASE__': JSON.stringify(release),
    // This bundle runs only on the Shopify storefronts (it talks to Brad's
    // server through the app proxy already — that's how chat works), so it is
    // a Shopify surface: without this define trackProductEvent no-ops and
    // chat_opened never fires from the site-wide FAB (US-15 AC2; the 2026-W33
    // product-health report found the event dead here while this surface
    // carried most chat traffic). Pinned by widget-src/vite-configs.test.ts.
    'import.meta.env.VITE_SHOPIFY_SURFACE': JSON.stringify('true'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/site-chat.tsx'),
      name: 'HealthSiteChat',
      fileName: () => 'health-site-chat.js',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, '../extensions/health-tool-widget/assets'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        assetFileNames: 'health-site-chat.[ext]',
      },
    },
    cssCodeSplit: false,
    sourcemap: 'hidden',
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
});
