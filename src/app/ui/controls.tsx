// The Studio's controls. Smooth over each setting's whole range (nothing snaps), tick marks at
// every whole step of the ±4 scale, a fill from neutral to the value, and double-click (or
// double-tap) to go back to neutral. Each is a real slider for the keyboard and screen readers.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cssColour } from '../../core/swatch'
import {
  defaultValue,
  displayValue,
  isBandAdjusted,
  MIX_BANDS,
  MONO_FILTERS,
  value as settingValue,
  withValue,
  type FilmSettings,
  type GradeTint,
  type Mix,
  type SettingInfo,
} from '../../core/settings'
import { model } from '../model'
import { shiftPad } from './swatches'
import { EdgePrint } from './theme'

export function DialSlider({ info, value, onChange }: { info: SettingInfo; value: number; onChange: (value: number) => void }) {
  const neutral = defaultValue(info.key)
  const span = info.max - info.min
  const fraction = (v: number) => ((v - info.min) / span) * 100
  const steps = Math.round(span * 4)
  const from = Math.min(fraction(neutral), fraction(value))
  const to = Math.max(fraction(neutral), fraction(value))
  const moved = Math.abs(value - neutral) >= 0.0005
  const id = `slider-${info.key}`
  return (
    <div className="dial" title={`${info.help}. Double-click to reset.`}>
      <div className="dial-head">
        <label htmlFor={id}>{info.name}</label>
        {info.photosOnly && (
          <EdgePrint tone="subtle" title="Too fine to see at viewfinder size, so the camera leaves it out of live view. Every developed photo has it; zoom in to see it.">
            not in viewfinder
          </EdgePrint>
        )}
        <output htmlFor={id} className={moved ? 'moved' : undefined}>
          {displayValue(info, value)}
        </output>
      </div>
      <div className="dial-track">
        <div className="dial-ticks" aria-hidden="true">
          {Array.from({ length: steps + 1 }, (_, step) => {
            const at = info.min + step / 4
            return <span key={step} className={Math.abs(at - neutral) < 1e-6 ? 'major' : undefined} style={{ left: `${(step / steps) * 100}%` }} />
          })}
        </div>
        <div className="dial-rail" aria-hidden="true">
          <span className="dial-fill" style={{ left: `${from}%`, width: `${to - from}%` }} />
        </div>
        <input
          id={id}
          type="range"
          min={info.min}
          max={info.max}
          step="any"
          value={value}
          aria-valuetext={displayValue(info, value)}
          aria-describedby={`${id}-help`}
          onChange={(e) => onChange(Number(e.target.value))}
          onKeyDown={(e) => {
            // a 16th of the range per arrow press, like the camera menu's steps
            const keys: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }
            if (keys[e.key] === undefined) return
            e.preventDefault()
            onChange(Math.min(Math.max(value + keys[e.key] * 0.0625, info.min), info.max))
          }}
          onDoubleClick={() => onChange(neutral)}
        />
        <span id={`${id}-help`} className="visually-hidden">
          {info.help}
        </span>
      </div>
    </div>
  )
}

/** Drag in a box: returns where the pointer is, 0..1 each way, while the button is down. */
function useDrag2D(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const handlers = {
    onPointerDown: (event: React.PointerEvent) => {
      ref.current?.setPointerCapture(event.pointerId)
      move(event)
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (ref.current?.hasPointerCapture(event.pointerId)) move(event)
    },
  }
  function move(event: React.PointerEvent) {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    onMove(Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1), Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1))
  }
  return { ref, handlers }
}

/** White-balance shift as a field of colour: red ↔ cyan across, blue ↔ yellow up and down. Each
 *  point is a grey through that shift (exaggerated so it's visible); faint dots mark the ±9 grid. */
export function ShiftPad({ red, blue, onChange }: { red: number; blue: number; onChange: (red: number, blue: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const image = shiftPad(model.engines.look)
    const c = canvas.current
    if (!c) return
    c.width = image.width
    c.height = image.height
    c.getContext('2d')?.putImageData(image, 0, 0)
  }, [])
  const { ref, handlers } = useDrag2D((x, y) => onChange(x * 2 - 1, 1 - y * 2))
  // the camera menu's ±9 steps, signed like the Mac app's "%+.1f"
  const signed = (v: number) => (v * 9 >= 0 ? '+' : '') + (v * 9).toFixed(1)
  const text = `R ${signed(red)}   B ${signed(blue)}`
  return (
    <div className="shift-pad" title="White-balance shift. Drag the point; double-click to reset. Top is blue, bottom yellow.">
      <div
        ref={ref}
        className="shift-pad-field"
        role="slider"
        tabIndex={0}
        aria-label="White-balance shift (left and right: cyan to red; up and down: blue to yellow)"
        aria-valuemin={-9}
        aria-valuemax={9}
        aria-valuenow={Math.round(red * 9 * 10) / 10}
        aria-valuetext={`red ${signed(red)}, blue ${signed(blue)}`}
        {...handlers}
        onDoubleClick={() => onChange(0, 0)}
        onKeyDown={(e) => {
          const step = 1 / 9
          const moves: Record<string, [number, number]> = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
          const m = moves[e.key]
          if (!m) return
          e.preventDefault()
          onChange(Math.min(Math.max(red + m[0], -1), 1), Math.min(Math.max(blue + m[1], -1), 1))
        }}
      >
        <canvas ref={canvas} aria-hidden="true" />
        <div className="shift-pad-grid" aria-hidden="true" />
        <span className="shift-pad-point" style={{ left: `${((red + 1) / 2) * 100}%`, top: `${((1 - blue) / 2) * 100}%` }} />
      </div>
      <div className="shift-pad-foot">
        <EdgePrint tone="subtle">cyan ← → red</EdgePrint>
        <span className={`mono ${red === 0 && blue === 0 ? 'subtle' : 'amber'}`}>{text}</span>
      </div>
    </div>
  )
}

/** A row of named choices, the current one lit. */
export function Chips<T extends { id: string; name: string }>({ items, current, onPick, label }: { items: T[]; current?: string; onPick: (item: T) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {items.map((item) => (
        <button key={item.id} type="button" className={`chip${item.id === current ? ' on' : ''}`} aria-pressed={item.id === current} onClick={() => onPick(item)}>
          {item.name}
        </button>
      ))}
    </div>
  )
}

export function FilterChips({ current, onPick }: { current?: string; onPick: (mix: Mix) => void }) {
  return <Chips items={MONO_FILTERS} current={current} onPick={(f) => onPick(f.mix)} label="Black-and-white filter" />
}

const gradeColour = (hue: number) => model.engines.look.gradeColour(hue)
const mixBandColour = (band: number) => model.engines.look.mixBandColour(band)
let gradeStrip: string | null = null
const GRADE_STRIP = () =>
  (gradeStrip ??= `linear-gradient(to right, ${Array.from({ length: 19 }, (_, i) => cssColour(gradeColour(i * 20))).join(', ')})`)

/** One colour-grading tint: how much, and which hue, picked on a strip of the colours the engine
 *  actually adds. */
export function GradeTintControl({ tint, hue, amount, onHue, onAmount }: { tint: GradeTint; hue: number; amount: number; onHue: (hue: number) => void; onAmount: (amount: number) => void }) {
  const id = `hue-${tint.hueKey}`
  return (
    <div className="grade-tint" title={`The ${tint.amount.name.toLowerCase()}' tint: drag along the strip to pick its colour, and set how strong it is above.`}>
      <DialSlider info={tint.amount} value={amount} onChange={onAmount} />
      <div className={`grade-hue${amount > 0 ? '' : ' faint'}`}>
        <span className="grade-dot" style={{ background: cssColour(gradeColour(hue)) }} aria-hidden="true" />
        <input
          id={id}
          type="range"
          min={0}
          max={359.96}
          step="any"
          value={hue}
          aria-label={`${tint.amount.name} tint hue`}
          aria-valuetext={`${Math.round(hue)} degrees`}
          style={{ background: GRADE_STRIP(), ['--thumb' as string]: cssColour(gradeColour(hue)) }}
          onChange={(e) => onHue(Number(e.target.value))}
          onDoubleClick={() => onHue(0)}
        />
        <output htmlFor={id} className={`mono ${amount > 0 ? 'amber' : 'subtle'}`}>
          {Math.round(hue)}°
        </output>
      </div>
    </div>
  )
}

/** The colour mixer: a chip for each band of colour (a dot on the ones you've changed), and the
 *  chosen band's hue, saturation and lightness below, so eight bands take the room of one. */
export function ColourMixer({ settings, onChange }: { settings: FilmSettings; onChange: (settings: FilmSettings) => void }) {
  const [chosen, setChosen] = useState(0)
  const band = MIX_BANDS[chosen]
  return (
    <div className="mixer">
      <div className="mixer-bands" role="group" aria-label="Colour band">
        {MIX_BANDS.map((each) => {
          const adjusted = isBandAdjusted(settings, each)
          return (
            <button
              key={each.band}
              type="button"
              className={`mixer-band${each.index === chosen ? ' on' : ''}`}
              aria-pressed={each.index === chosen}
              aria-label={each.name + (adjusted ? ', changed' : '')}
              title={each.name + (adjusted ? ', changed' : '')}
              onClick={() => setChosen(each.index)}
            >
              <span style={{ background: cssColour(mixBandColour(each.index)) }} />
              {adjusted && <i className="dot" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <div className="mixer-head">
        <strong>{band.name}</strong>
        <button
          type="button"
          className="link-button"
          disabled={!isBandAdjusted(settings, band)}
          onClick={() => onChange(band.settings.reduce((s, info) => withValue(s, info.key, 0), settings))}
        >
          Reset {band.band}
        </button>
      </div>
      {band.settings.map((info) => (
        <DialSlider key={info.key} info={info} value={settingValue(settings, info.key)} onChange={(v) => onChange(withValue(settings, info.key, v))} />
      ))}
    </div>
  )
}

/** A native select drawn as its chosen option's text, which wraps instead of being cut off; the
 *  select itself lies invisibly on top, so tapping opens the system's own list. */
export function SelectBox({ label, value, shown, onChange, children, className }: { label: string; value: string; shown: string; onChange: (value: string) => void; children: ReactNode; className?: string }) {
  return (
    <label className={`select-box${className ? ` ${className}` : ''}`}>
      <span className="select-box-text">{shown}</span>
      <span className="subtle" aria-hidden="true">
        ⌄
      </span>
      <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  )
}
