import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { gameServerPlugin } from './server/vite-plugin'

/**
 * Stable renderer host for long sprite-bake runs.
 *
 * The normal development server deliberately hot-reloads every source edit.
 * That is useful while authoring, but a concurrent edit can dispose Phaser's
 * scene halfway through a multi-minute bake and leave a partial atlas. This
 * host keeps the source snapshot it booted with until the process exits.
 */
export default defineConfig({
  plugins: [react(), gameServerPlugin()],
  server: {
    hmr: false,
    watch: {
      ignored: ['**/*']
    }
  }
})
