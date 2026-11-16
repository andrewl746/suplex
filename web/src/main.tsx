import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@contracts/design-tokens.css'
import './styles/palette.css'
import './styles/typography.css'
import './styles/app.css'
import './styles/multiplex-theme.css'
import { AppLoader } from './AppLoader.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppLoader />
  </StrictMode>,
)
