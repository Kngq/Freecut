import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Separate from vite.config.ts on purpose: the app's config pulls in the Electron build
// plugins, which the pure-function unit tests under src/shared have no need for.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['src/**/*.test.ts']
  }
})
