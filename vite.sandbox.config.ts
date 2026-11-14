import { defineConfig } from 'vite'

/**
 * The Canvas sandbox page (src/sandbox), built on its own into dist/sandbox
 * so it can be served from a separate origin (docs/CANVAS-SPEC.md §8).
 * Relative asset paths let it live at any path on that origin.
 */
export default defineConfig({
  root: 'src/sandbox',
  base: './',
  build: {
    outDir: '../../dist/sandbox',
    emptyOutDir: true,
    // Vega is large; it is this page's whole job.
    chunkSizeWarningLimit: 2000,
  },
})
