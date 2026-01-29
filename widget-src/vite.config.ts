import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'HealthTool',
      fileName: () => 'health-tool.js',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, '../extensions/health-tool-widget/assets'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        // Include CSS in the JS bundle
        assetFileNames: 'health-tool.[ext]',
      },
    },
    // Inline the CSS into the JS
    cssCodeSplit: false,
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
});
