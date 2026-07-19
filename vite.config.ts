import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { gameServerPlugin } from './server/vite-plugin'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Vite intentionally exposes only VITE_* values to browser code. Load the
  // three operator-only values into the Node process for the same-origin game
  // server plugin, while keeping them completely absent from client bundles.
  const serverEnv = loadEnv(mode, process.cwd(), '')
  for (const key of ['CLASH_ADMIN_USERNAME', 'CLASH_ADMIN_PASSWORD', 'CLASH_ADMIN_SESSION_SECRET'] as const) {
    if (process.env[key] === undefined && serverEnv[key] !== undefined) process.env[key] = serverEnv[key]
  }

  return {
    plugins: [react(), tailwindcss(), gameServerPlugin()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      chunkSizeWarningLimit: 1300,
      rollupOptions: {
        output: {
          manualChunks(id) {
            return id.split('?')[0].includes('/node_modules/phaser/')
              ? 'phaser'
              : undefined
          },
          onlyExplicitManualChunks: true,
        }
      }
    }
  }
})
