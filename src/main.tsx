import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const isAdminRoute = window.location.pathname.startsWith('/admin')
const isIntroBattleDemoRoute = import.meta.env.DEV && window.location.pathname === '/dev/intro-battle'
const favicon = document.querySelector<HTMLLinkElement>('#site-favicon')
if (favicon) favicon.href = isAdminRoute ? '/admin-favicon.svg' : '/favicon.svg'

// Last line of defence: nothing that slips every other guard may die silently.
// Throttled so an error storm cannot itself become the problem.
let lastGlobalErrorAt = 0
const logGlobal = (kind: string, detail: unknown) => {
  const now = Date.now()
  if (now - lastGlobalErrorAt < 3000) return
  lastGlobalErrorAt = now
  console.error(`[global ${kind}]`, detail)
}
window.addEventListener('error', event => logGlobal('error', event.error ?? event.message))
window.addEventListener('unhandledrejection', event => logGlobal('rejection', event.reason))

/**
 * The whole-app bulkhead. Without it, ONE exception in any component's render
 * unmounts the entire React root — a blank white page, mid-raid, with the
 * game canvas torn down. With it, the player gets a calm reload screen and a
 * reminder that the server holds their village.
 */
class RootErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('[root boundary] render crash:', error, info)
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16,
        background: '#101418', color: '#f0e8d0', fontFamily: 'monospace', textAlign: 'center', padding: 24
      }}>
        <div style={{ fontSize: 18, fontWeight: 'bold' }}>Something broke on this screen.</div>
        <div style={{ fontSize: 13, opacity: 0.8, maxWidth: 420 }}>
          Your village is safe — everything important lives on the server.
          Reload to jump back in.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 8, padding: '10px 26px', fontSize: 14, fontFamily: 'monospace',
            background: '#daa520', color: '#1c1408', border: 'none', borderRadius: 6, cursor: 'pointer'
          }}
        >
          RELOAD
        </button>
      </div>
    )
  }
}

const rootNode = document.getElementById('root')
if (!rootNode) {
  document.body.innerHTML = '<p style="font-family:monospace;padding:24px">Boot failed: missing #root. Please reload.</p>'
}

async function boot() {
  if (!rootNode) return

  // Keep the privileged surface out of the game bootstrap entirely: visiting
  // /admin never imports App, Phaser, the player auth client, or pixel-kit.
  const surface: ReactNode = isAdminRoute
    ? await import('./admin/AdminPortal.tsx').then(module => <module.AdminPortal />)
    : isIntroBattleDemoRoute
      ? await import('./dev/IntroBattleDemo.tsx').then(module => <module.IntroBattleDemo />)
    : await Promise.all([import('./App.tsx'), import('./ui/pixelKit')]).then(([appModule, pixelKit]) => {
        // Game DOM chrome expects these variables before its first render.
        pixelKit.installPixelKit()
        const App = appModule.default
        return <App />
      })

  createRoot(rootNode).render(
    <StrictMode>
      <RootErrorBoundary>{surface}</RootErrorBoundary>
    </StrictMode>,
  )
}

void boot().catch(error => {
  logGlobal('boot', error)
  if (rootNode) rootNode.innerHTML = '<p style="font-family:monospace;padding:24px">Boot failed. Please reload.</p>'
})
