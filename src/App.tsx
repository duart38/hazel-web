import { useEffect, useState } from 'react'
import { Camera } from './app/Camera'
import { Darkroom } from './app/Darkroom'
import { loadEngines } from './app/engines'
import { model, PLACES, useModel, type Place } from './app/model'
import { Recipes } from './app/Recipes'
import { Studio } from './app/Studio'
import { Spinner } from './app/ui/theme'

const ICONS: Record<Place, string> = { darkroom: '▤', recipes: '▦', studio: '◐', camera: '◉' }

export default function App() {
  const state = useModel()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadEngines()
      .then(async (engines) => {
        await model.start(engines)
        if (!engines.webgl2) model.notify('No WebGL2 in this browser: pictures change once a change is developed, not while you drag.')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  // leaving with unsaved Studio changes asks first, as switching recipes does
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (model.state.unsaved) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  // Alt+1..4 switch tabs (Ctrl/⌘ and the digits belong to zoom)
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return
      const place = PLACES[Number(event.code.replace('Digit', '')) - 1]
      if (!place) return
      event.preventDefault()
      model.setPlace(place.id)
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [])

  if (error) {
    return (
      <main className="boot">
        <h1>Hazel couldn't start</h1>
        <p className="subtle">{error}</p>
      </main>
    )
  }
  if (!state.loaded) {
    return (
      <main className="boot">
        <Spinner label="Starting Hazel" />
      </main>
    )
  }

  return (
    <div className="app">
      <nav className="tabs" aria-label="Hazel">
        <span className="brand" aria-hidden="true">
          Hazel
        </span>
        {PLACES.map((place, i) => (
          <button
            key={place.id}
            type="button"
            className={`tab${state.place === place.id ? ' on' : ''}`}
            aria-current={state.place === place.id ? 'page' : undefined}
            title={`${place.name} (Alt ${i + 1})`}
            onClick={() => model.setPlace(place.id)}
          >
            <span className="tab-icon" aria-hidden="true">
              {ICONS[place.id]}
            </span>
            <span className="tab-name">{place.name}</span>
            {place.id === 'studio' && state.unsaved && <span className="dot" aria-label="unsaved changes" />}
          </button>
        ))}
        <EngineNote />
      </nav>
      {/* every tab stays alive, as in the Mac app: the Studio keeps its undo history */}
      <main className="content">
        <div className="place" hidden={state.place !== 'darkroom'}>
          <Darkroom />
        </div>
        <div className="place" hidden={state.place !== 'recipes'}>
          <Recipes />
        </div>
        <div className="place" hidden={state.place !== 'studio'}>
          <Studio />
        </div>
        <div className="place" hidden={state.place !== 'camera'}>
          <Camera />
        </div>
      </main>
      <Notice />
    </div>
  )
}

/** Without WebGL2 everything still works, but pictures only change when the look engine is
 *  done, so say why sliders feel slow. */
function EngineNote() {
  if (model.engines.webgl2) return null
  return (
    <p className="engine-note" role="note">
      This browser has no WebGL2: pictures update when a change is developed, not while you drag, and raws develop more slowly. A current Chrome, Edge, Firefox or Safari has it.
    </p>
  )
}

/** A short message at the bottom of the window, for four seconds. */
function Notice() {
  const { notice } = useModel()
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => model.dismissNotice(notice.id), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])
  return (
    <div className="notice-area" aria-live="polite">
      {notice && (
        <button type="button" className="notice" onClick={() => model.dismissNotice(notice.id)} title="Dismiss">
          {notice.text}
        </button>
      )}
    </div>
  )
}
