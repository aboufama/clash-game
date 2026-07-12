import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { gameServerPlugin } from './server/vite-plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), gameServerPlugin()],
  build: {
    chunkSizeWarningLimit: 1300,
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ['phaser'],
          react: ['react', 'react-dom']
        }
      }
    }
  }
})
