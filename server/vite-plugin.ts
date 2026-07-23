import type { PluginOption } from 'vite'
import { createGameServer } from './node-adapter'

/**
 * Runs the game backend inside the Vite dev server, so `npm run dev` gives a
 * fully working game at one URL with zero extra processes. State persists to
 * server/data/ exactly like the standalone production server.
 */
export function gameServerPlugin(): PluginOption {
  return {
    name: 'clash-game-server',
    configureServer(server) {
      // A dev server IS a dev environment: every login gets unlimited
      // resources by default, however vite was launched (npm run dev, bare
      // `npx vite`, harness servers on other ports). Explicitly exporting
      // CLASH_INFINITE_RESOURCES=0 restores real balances for economy work.
      // Production (server/index.ts) never runs through this plugin and is
      // untouched.
      process.env.CLASH_INFINITE_RESOURCES ??= '1'
      const { middleware, close } = createGameServer()
      server.httpServer?.once('close', close)
      // Vite doesn't always emit httpServer 'close' on Ctrl+C, so persist on the
      // process signals too (close is synchronous and idempotent).
      const onSignal = () => close()
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
      process.once('exit', onSignal)
      server.middlewares.use((req, res, next) => {
        // localhost and 127.0.0.1 are DIFFERENT browser origins with separate
        // localStorage — a device token saved on one is invisible on the
        // other, so a player who switches spelling gets a fresh guest village
        // and "loses" their base. Canonicalize to 127.0.0.1 (the host the dev
        // script binds) so this machine only ever has one game origin.
        const host = req.headers.host ?? ''
        if (host === 'localhost' || host.startsWith('localhost:')) {
          const port = host.split(':')[1] ?? '5173'
          res.statusCode = 301
          res.setHeader('Location', `http://127.0.0.1:${port}${req.url ?? '/'}`)
          res.end()
          return
        }
        void middleware(req, res).then(handled => {
          if (!handled) next()
        }).catch(next)
      })
    }
  }
}
