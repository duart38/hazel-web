// Putting Hazel on the camera, and the seven recipe slots on its card. C1 to C7 are always what
// the card holds: picking a recipe for a slot writes it there, and recipes saved or changed on
// the camera show up here to keep. A browser that can't write to the card plans the slots and
// downloads them instead.

import { useState } from 'react'
import { recipeSummary } from '../core/recipe'
import { SLOT_NAMES, storedText, type SlotName } from '../core/library'
import { canPickFolders, pickFiles } from './folders'
import { InstallHazel } from './InstallHazel'
import { model, useModel } from './model'
import { SamplePicker } from './SamplePicker'
import { SelectBox } from './ui/controls'
import { Confirm } from './ui/overlays'
import { Thumbnail } from './ui/pictures'
import { EdgePrint } from './ui/theme'

const ONLY_ON_CARD = '\u0000card'

export function Camera() {
  const state = useModel()
  const card = state.card
  return (
    <section className="screen camera" aria-labelledby="camera-title">
      <header className="toolbar">
        <h1 id="camera-title" className="toolbar-title">
          Camera
        </h1>
      </header>
      <div className="scroll">
        <div className="page">
          <InstallHazel />
          <section className="group" aria-labelledby="slots-title">
            <h2 id="slots-title">
              <EdgePrint>Recipes on the card</EdgePrint>
            </h2>
            {card?.writable ? <OnCard /> : canPickFolders() ? <NoCard /> : <Planned />}
          </section>
        </div>
      </div>
    </section>
  )
}

/** The card is open: its slots, as the camera reads them. */
function OnCard() {
  const state = useModel()
  const card = state.card
  if (!card) return null
  const cardOnly = SLOT_NAMES.filter((slot) => model.slotStatus(slot) === 'card only')
  return (
    <>
      <div className="row card-row">
        <span className="card-icon" aria-hidden="true">
          ▣
        </span>
        <strong>{card.name}</strong>
        <span className="spacer" />
        <button type="button" className="button" onClick={() => void model.refreshCardSlots()}>
          Read again
        </button>
        <button type="button" className="button" onClick={() => void model.chooseCard()}>
          Another card…
        </button>
      </div>
      <p className="subtle">
        C1 to C7 are the recipes on this card, the ones the camera offers under Settings, Extras. Choose one of your recipes for a slot and it goes onto the card straight away. Recipes saved or
        changed on the camera show up here too.
      </p>
      {cardOnly.length > 0 && (
        <div className="row card-note">
          <span>
            {cardOnly.length === 1 ? `${slotName(cardOnly[0])} is` : `${cardOnly.length} recipes are`} on the card but not in your recipes.
          </span>
          <span className="spacer" />
          <button type="button" className="button primary" onClick={() => void model.keepAllFromCard()}>
            {cardOnly.length === 1 ? 'Add it to my recipes' : 'Add them to my recipes'}
          </button>
        </div>
      )}
      <SamplePicker />
      <div className="tile-grid slots">
        {SLOT_NAMES.map((slot) => (
          <CardSlot key={slot} slot={slot} />
        ))}
      </div>
    </>
  )
}

function slotName(slot: SlotName): string {
  const text = model.state.cardSlots?.[slot]
  return (text && recipeSummary(text)) ?? slot
}

/** One slot on the card: its recipe on the sample photo, which of yours it is, and a way to
 *  keep it when it's only on the card or was changed on the camera. */
function CardSlot({ slot }: { slot: SlotName }) {
  const state = useModel()
  const [asking, setAsking] = useState(false)
  const text = state.cardSlots?.[slot]
  const name = text ? (recipeSummary(text) ?? slot) : undefined
  const status = model.slotStatus(slot)
  const id = `slot-${slot}`
  const keep = (how: 'copy' | 'replace') => {
    setAsking(false)
    void model.keepFromCard(slot, how)
  }
  return (
    <article className="tile slot" aria-labelledby={`${id}-label`}>
      <div className="tile-picture">
        {text ? <Thumbnail photo={model.sample()} recipe={text} size={900} /> : <span className="slot-empty">Empty</span>}
        <span className="badge slot-badge" id={`${id}-label`}>
          {slot}
        </span>
        {status === 'card only' && (
          <span className="slot-state">
            <EdgePrint>only on the card</EdgePrint>
          </span>
        )}
        {status === 'changed' && (
          <span className="slot-state">
            <EdgePrint tone="safelight">changed on the camera</EdgePrint>
          </span>
        )}
      </div>
      <div className="row tight">
        <SelectBox
          className="grow"
          label={`Recipe in ${slot}`}
          value={status === 'card only' ? ONLY_ON_CARD : (name ?? '')}
          shown={name ?? 'Empty'}
          onChange={(v) => {
            if (v !== ONLY_ON_CARD) void model.setSlot(slot, v || null)
          }}
        >
          <option value="">Empty</option>
          {status === 'card only' && <option value={ONLY_ON_CARD}>{name} (only on the card)</option>}
          {state.recipes.map((r) => (
            <option key={r.file} value={r.name}>
              {r.name}
            </option>
          ))}
        </SelectBox>
      </div>
      {status === 'card only' && (
        <button type="button" className="button" onClick={() => void model.keepFromCard(slot, 'add')}>
          Add to my recipes
        </button>
      )}
      {status === 'changed' && (
        <button type="button" className="button" onClick={() => setAsking(true)}>
          Keep the camera's version…
        </button>
      )}
      <Confirm
        open={asking}
        title={`Keep the camera's ${name ?? slot}?`}
        message={`${name} on the card isn't the same as yours: it was changed on the camera. Replace yours with it, or keep both.`}
        choices={[
          { label: 'Save as a copy', run: () => keep('copy') },
          { label: 'Replace mine', kind: 'primary', run: () => keep('replace') },
        ]}
        onCancel={() => setAsking(false)}
      />
    </article>
  )
}

/** No card open yet, in a browser that can open it. */
function NoCard() {
  const state = useModel()
  return (
    <>
      <div className="row card-row">
        <span className="subtle">Put the camera's card in a card reader, then choose it. C1 to C7 show what's on it.</span>
        <span className="spacer" />
        {state.waiting.card && (
          <button type="button" className="button" onClick={() => void model.reopenWaiting('card')}>
            Use {state.waiting.card.name} again
          </button>
        )}
        <button type="button" className="button primary" onClick={() => void model.chooseCard()}>
          Choose card…
        </button>
      </div>
    </>
  )
}

/** A browser that can't write to a card: plan the slots here, download them, copy them on. */
function Planned() {
  return (
    <>
      <p className="subtle">
        This browser can't write to the card, so plan the slots here, then download them and copy them onto the card. Chrome or Edge write them straight to the card and show what's on it.
      </p>
      <SamplePicker />
      <div className="tile-grid slots">
        {SLOT_NAMES.map((slot) => (
          <PlannedSlot key={slot} slot={slot} />
        ))}
      </div>
      <div className="row card-row">
        <span className="subtle">Unzip HAZEL.zip at the top of the card, next to DCIM, replacing any HAZEL folder there.</span>
        <span className="spacer" />
        <button
          type="button"
          className="button"
          onClick={async () => {
            const files = await pickFiles({ directory: true })
            if (files.length > 0) await model.openFileList(files)
          }}
        >
          Read card…
        </button>
        <button type="button" className="button safelight" onClick={() => void model.writeSlotsToCard()}>
          Download for the card
        </button>
      </div>
    </>
  )
}

function PlannedSlot({ slot }: { slot: SlotName }) {
  const state = useModel()
  const name = state.slots[slot]
  const stored = name ? model.recipeNamed(name) : undefined
  const id = `slot-${slot}`
  return (
    <article className="tile slot" aria-labelledby={`${id}-label`}>
      <div className="tile-picture">
        {stored ? <Thumbnail photo={model.sample()} recipe={storedText(stored)} size={900} /> : <span className="slot-empty">Empty</span>}
        <span className="badge slot-badge" id={`${id}-label`}>
          {slot}
        </span>
      </div>
      <div className="row tight">
        <SelectBox className="grow" label={`Recipe in ${slot}`} value={stored ? stored.name : ''} shown={stored ? stored.name : 'Empty'} onChange={(v) => void model.setSlot(slot, v || null)}>
          <option value="">Empty</option>
          {state.recipes.map((r) => (
            <option key={r.file} value={r.name}>
              {r.name}
            </option>
          ))}
        </SelectBox>
      </div>
    </article>
  )
}
