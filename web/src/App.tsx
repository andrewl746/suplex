import { useEffect, type CSSProperties } from 'react'
import { BaseMap } from './components/BaseMap/BaseMap'
import { DataBadges } from './components/DataBadges'
import { GraphicsBoundary } from './components/GraphicsBoundary'
import { Landing } from './components/Landing/Landing'
import { Scene } from './components/Lot3D/Scene'
import { PlanTab } from './components/Plan/PlanTab'
import { ResultPanel } from './components/ResultPanel/ResultPanel'
import { Search } from './components/Search/Search'
import { MultiplexSearchEntry } from './components/WardMap/MultiplexSearchEntry'
import { WardStage } from './components/WardStage/WardStage'
import { labels } from './copy'
import { useLayout } from './layout'
import { useApp } from './state/store'
import { useUrlSync } from './state/useUrlSync'

export default function App() {
  useUrlSync()
  const view = useApp((s) => s.view)
  const handoff = useApp((s) => s.handoff)
  const check = useApp((s) => s.check)
  const designId = useApp((s) => s.designId)
  const graphics = useApp((s) => s.graphics)
  const graphicsFailed = useApp((s) => s.graphicsFailed)
  const layout = useLayout()
  usePageHome()
  const inLot = view === 'lot'
  // The street is built as the check comes back (before the flight starts) and shown from the
  // handoff, over the flight's last stretch.
  // The plan and ward views keep the street built behind them, so the way back to the 3D lot is instant.
  const sceneCheck = view === 'landing' ? null : check
  return (
    <main
      className="app"
      data-view={view}
      data-layout={layout.mode}
      data-compact={layout.compact || undefined}
      style={
        {
          '--panel-width': `${layout.panelWidthPx}px`,
          '--sheet-peek': `${layout.sheetPeekPx}px`,
          '--sheet-top': `${layout.sheetTopPx}px`,
        } as CSSProperties
      }
    >
      {graphics && (
        <GraphicsBoundary onError={graphicsFailed}>
          <BaseMap />
          {/* Always mounted so its shaders are ready before the first address (see Scene). */}
          <Scene
            check={sceneCheck}
            designId={designId}
            visible={(inLot || handoff) && sceneCheck !== null}
            insets={layout.insets}
            pinLabels={layout.compact}
          />
        </GraphicsBoundary>
      )}
      {(view === 'landing' || view === 'flying') && <Landing leaving={view === 'flying'} />}
      {(inLot || view === 'toWard') && <LotChrome leaving={view === 'toWard'} />}
      {view === 'plan' && <PlanTab />}
      {graphics && (
        <GraphicsBoundary onError={graphicsFailed}>
          <WardStage />
        </GraphicsBoundary>
      )}
      <DataBadges />
      <MultiplexSearchEntry showButton={view === 'landing'} />
    </main>
  )
}

/**
 * The page itself never scrolls (app.css), but a phone can still shift it: to bring a text box above
 * its keyboard, or when the browser takes a drag for its own. Left shifted, everything is drawn a
 * little away from where a tap lands. So whenever the page finds itself moved and nobody is typing,
 * it goes back.
 */
function usePageHome() {
  useEffect(() => {
    const home = () => {
      if (document.activeElement instanceof HTMLInputElement) return
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
    }
    window.addEventListener('scroll', home, { passive: true })
    document.addEventListener('focusout', home)
    return () => {
      window.removeEventListener('scroll', home)
      document.removeEventListener('focusout', home)
    }
  }, [])
}

/** The address check's search bar and result panel (MASTERSPEC 6.2), over the 3D scene. */
function LotChrome({ leaving }: { leaving: boolean }) {
  const showLanding = useApp((s) => s.showLanding)
  const showPlan = useApp((s) => s.showPlan)
  return (
    <div className={leaving ? 'lot-chrome lot-chrome-leaving' : 'lot-chrome'}>
      <div className="topbar">
        <button type="button" className="brand" aria-label="Suplex" onClick={() => showLanding()}>
          <span className="brand-mark" />
        </button>
        <Search variant="compact" />
        <button type="button" className="plan-switch" onClick={() => showPlan()}>
          {labels.ui.view_2d}
        </button>
      </div>
      <ResultPanel />
    </div>
  )
}

