// Builds the embeddable widget bundle. UMD for legacy host sites, ES module for modern.
// All CSS selectors are prefixed `.shp-` to avoid host-site collisions.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'V3BookingWidget',
      formats: ['es', 'umd'],
      fileName: (format) => `widget.${format}.js`,
    },
    rollupOptions: {
      external: [],
      output: {
        inlineDynamicImports: true,
      },
    },
    sourcemap: true,
    target: 'es2020',
  },
});
