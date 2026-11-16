import { lazy } from 'react'
import { WarmupGate } from './components/Warmup/WarmupGate'

// The app (the map and the 3D scene with it) loads as its own file, so the live site's loading screen
// (WarmupGate) is on screen first and the two loads run side by side.
const appCode = import('./App.tsx')
const App = lazy(() => appCode)

/** The app behind its loading screen, which only the live site shows (api/config.ts, WARMUP_URL). */
export function AppLoader() {
  return (
    <WarmupGate preload={appCode}>
      <App />
    </WarmupGate>
  )
}
