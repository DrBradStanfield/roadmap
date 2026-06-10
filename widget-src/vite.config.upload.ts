import { defineConfig } from 'vite';
import { resolve } from 'path';
import { execSync } from 'child_process';

const gitHash = execSync('git rev-parse --short HEAD').toString().trim();
const release = `health-tool-widget@${gitHash}`;

// Upload processing bundle — separate IIFE, loaded on demand.
// Contains pdfjs-dist + JSZip + extraction logic. No React.
export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    '__SENTRY_RELEASE__': JSON.stringify(release),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/upload-entry.ts'),
      name: 'HealthUpload',
      fileName: () => 'health-upload.js',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, '../extensions/health-tool-widget/assets'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        assetFileNames: 'health-upload.[ext]',
      },
    },
    cssCodeSplit: false,
    // Shopify build keeps hidden maps (Sentry); the Pages build must not
    // publish a 2.9 MB public map alongside the bundle.
    sourcemap: process.env.PAGES_BUILD ? false : 'hidden',
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
});
