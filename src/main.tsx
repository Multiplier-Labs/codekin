import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// VITE_APP_MODE=hosted builds the app.codekin.ai shell; the default build is
// the local app. Lazy imports keep the other mode's bundle out of the build.
// eslint-disable-next-line react-refresh/only-export-components -- entry point, fast refresh does not apply
const App =
  import.meta.env.VITE_APP_MODE === 'hosted'
    ? lazy(() => import('./hosted/HostedApp.tsx'))
    : lazy(() => import('./App.tsx'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <App />
    </Suspense>
  </StrictMode>,
)
