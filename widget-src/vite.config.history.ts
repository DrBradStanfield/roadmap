import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Health history page — separate IIFE bundle.
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/history.tsx'),
      name: 'HealthHistory',
      fileName: () => 'health-history.js',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, '../extensions/health-tool-widget/assets'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        assetFileNames: 'health-history.[ext]',
      },
    },
    cssCodeSplit: false,
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
});
