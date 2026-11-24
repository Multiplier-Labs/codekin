import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Points DATA_DIR at a temporary folder so no test reaches ~/.codekin.
    setupFiles: ['../vitest.setup.ts'],
  },
})
