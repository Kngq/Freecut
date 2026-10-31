import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import renderer from 'vite-plugin-electron-renderer'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': path.resolve(__dirname, 'src/shared')
            }
          },
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['fluent-ffmpeg', 'ffmpeg-static', 'ffprobe-static', 'onnxruntime-node']
            }
          }
        }
      },
      preload: {
        input: 'electron/preload/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/preload'
          }
        }
      },
      renderer: {}
    }),
    renderer()
  ]
})
