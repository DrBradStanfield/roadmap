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

// Single-topic widgets (US-74 AC8): one IIFE bundle for every theme block that
// names its topic in `data-widget`; a new topic adds a component, not a bundle.
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    '__SENTRY_RELEASE__': JSON.stringify(release),
    // A Shopify surface: its usage events (waist_widget_viewed / _saved) go
    // through the app proxy, and trackProductEvent no-ops without this.
    'import.meta.env.VITE_SHOPIFY_SURFACE': JSON.stringify('true'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'standalone/widgets.tsx'),
      name: 'HealthWidgets',
      fileName: () => 'health-widgets.js',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, '../extensions/health-tool-widget/assets'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        assetFileNames: 'health-widgets.[ext]',
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
