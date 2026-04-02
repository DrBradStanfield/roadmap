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
