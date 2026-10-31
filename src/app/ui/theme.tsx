// The darkroom look: warm near-black, amber edge print (the frame numbers printed along real
// film), and a safelight red for anything that changes the camera. Colours live in index.css.

import type { ReactNode } from 'react'
import { cssColour } from '../../core/swatch'
import type { LookSettings } from '../../engine/types'
import { model } from '../model'
import { swatchStrip } from './swatches'

/** Film edge print: small, spaced-out capitals. */
export function EdgePrint({ children, tone = 'amber', title }: { children: ReactNode; tone?: 'amber' | 'subtle' | 'safelight' | 'white'; title?: string }) {
  return (
    <span className={`edge-print edge-${tone}`} title={title}>
      {children}
    </span>
  )
}

/** The recipe's colours: skin, sky, foliage, red, yellow and three greys, run through it. */
export function SwatchStrip({ recipe, look, className }: { recipe: string; look?: LookSettings; className?: string }) {
  const colours = swatchStrip(model.engines.look, look ? JSON.stringify(look) : recipe, look ?? model.engines.look.parse(recipe))
  return (
    <div className={`swatch-strip ${className ?? ''}`} aria-hidden="true">
      {colours.map((c, i) => (
        <span key={i} style={{ background: cssColour(c) }} />
      ))}
    </div>
  )
}

/** A recipe as a film box: its label is the recipe's own colours, so recipes tell apart at a glance. */
export function FilmBox(props: {
  name: string
  recipe: string
  look?: LookSettings
  slot?: string
  selected?: boolean
  compact?: boolean
  edited?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className={`film-box${props.compact ? ' compact' : ''}${props.selected ? ' selected' : ''}`}
      aria-current={props.selected ? 'true' : undefined}
      onClick={props.onClick}
    >
      <SwatchStrip recipe={props.recipe} look={props.look} />
      <span className="film-box-label">
        {props.slot && <EdgePrint>{props.slot}</EdgePrint>}
        <span className="film-box-name">{props.name}</span>
        {props.edited && <span className="dot" title="Not saved yet" aria-label="not saved yet" />}
      </span>
    </button>
  )
}

export function Spinner({ label = 'Working' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />
}
