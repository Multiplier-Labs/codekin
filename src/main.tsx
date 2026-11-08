import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts are bundled, not fetched from Google Fonts: the CSP allows no
// third-party origins, and visitors' IPs stay off Google's servers.
import '@fontsource-variable/inconsolata/wght.css'
import '@fontsource/lato/300.css'
import '@fontsource/lato/400.css'
import '@fontsource/lato/700.css'
import './index.css'

// VITE_APP_MODE=hosted builds the app.codekin.ai shell; the default build is
// the local app. Lazy imports keep the other mode's bundle out of the build.
// eslint-disable-next-line react-refresh/only-export-components -- entry point, fast refresh does not apply
const App =
  import.meta.env.VITE_APP_MODE === 'hosted'
    ? lazy(() => import('./hosted/HostedApp.tsx'))
    : lazy(() => import('./App.tsx'))

// Hosted only: uncaught errors go to the relay, which scrubs and forwards
// them if error reporting is configured there.
if (import.meta.env.VITE_APP_MODE === 'hosted') {
  void import('./hosted/errorReporting').then(m => { m.installErrorReporting() })
  void import('./hosted/stagingBadge').then(m => m.showStagingBadgeIfNeeded())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <App />
    </Suspense>
  </StrictMode>,
)
