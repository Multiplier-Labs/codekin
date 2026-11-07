import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'server/**/*.test.ts',
      '.claude/hooks/**/*.test.mjs',
      'bin/**/*.test.mjs',
      'desktop/scripts/**/*.test.mjs',
    ],
    env: { NODE_ENV: 'test' },
    // Node 25+ enables its own Web Storage global by default; without
    // --localstorage-file it is `undefined` and shadows jsdom's localStorage,
    // breaking every jsdom test that touches storage. Disable it in workers.
    execArgv: ['--no-experimental-webstorage'],
    coverage: {
      provider: 'v8',
      // Measure every source file, not just those a test happens to import.
      // Without this, never-imported files (UI components, App.tsx, ws-server.ts)
      // silently drop out of the denominator and inflate the headline number.
      all: true,
      include: [
        'src/**/*.{ts,tsx}',
        'server/**/*.ts',
        '.claude/hooks/**/*.mjs',
        'bin/**/*.mjs',
      ],
      exclude: [
        '**/*.test.*',
        '**/*.d.ts',
        'server/dist/**',
        'src/types.ts',
        'server/types.ts',
        'server/stepflow-types.ts',
        'server/webhook-types.ts',
        'src/main.tsx',
      ],
    },
  },
})
