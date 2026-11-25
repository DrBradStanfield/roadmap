import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  /* not a git checkout */
}
const release = `health-tool-widget@${gitHash}`;

// Embedded chatbot panel — separate IIFE bundle.
// Mounted as a section block on any storefront page.
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    '__SENTRY_RELEASE__': JSON.stringify(release),
    // A theme-extension block, so it runs only on the Shopify storefronts: a
    // Shopify surface (US-15 AC2a). In this bundle the flag turns on only
    // trackProductEvent, for chat_thinking_opened and chat_panel_shown (US-15 AC77). Pinned by vite-configs.test.ts.
    'import.meta.env.VITE_SHOPIFY_SURFACE': JSON.stringify('true'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/chatbot-embed.tsx'),
      name: 'HealthChatbotEmbed',
      fileName: () => 'health-chatbot-embed.js',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, '../extensions/health-tool-widget/assets'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        assetFileNames: 'health-chatbot-embed.[ext]',
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
