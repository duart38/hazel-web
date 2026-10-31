// The camera's seven recipe slots, and getting them onto its card.

import { SLOT_NAMES, storedText, type SlotName } from '../core/library'
import { canPickFolders, pickFiles } from './folders'
import { model, useModel } from './model'
import { SamplePicker } from './SamplePicker'
import { SelectBox } from './ui/controls'
import { Thumbnail } from './ui/pictures'
import { EdgePrint } from './ui/theme'

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
          <section className="group" aria-labelledby="slots-title">
            <h2 id="slots-title">
              <EdgePrint>Slots</EdgePrint>
            </h2>
            <p className="subtle">Pick a recipe for each slot and write them to the camera's card. On the camera, choose a slot under Settings, Extras.</p>
            <SamplePicker />
            <div className="tile-grid slots">
              {SLOT_NAMES.map((slot) => (
                <SlotCard key={slot} slot={slot} />
              ))}
            </div>
          </section>

          <section className="group" aria-labelledby="card-title">
            <h2 id="card-title">
              <EdgePrint>Card</EdgePrint>
            </h2>
            {card ? (
              <>
                <div className="row card-row">
                  <span className="card-icon" aria-hidden="true">
                    ▣
                  </span>
                  <strong>{card.name}</strong>
                  <span className="spacer" />
                  {canPickFolders() && (
                    <button type="button" className="button" onClick={() => void model.chooseCard()}>
                      Another card…
                    </button>
                  )}
                  <button type="button" className="button safelight" onClick={() => void model.writeSlotsToCard()}>
                    {card.writable ? 'Write slots to card' : 'Download for the card'}
                  </button>
                </div>
                <p className="subtle small">
                  {card.writable
                    ? 'Writes the recipes into a HAZEL folder on the card, next to the photos. Nothing on the camera itself changes; formatting the card removes them.'
                    : "This browser can't write to the card. Download HAZEL.zip and unzip it at the top of the card, next to DCIM, replacing any HAZEL folder there. Nothing on the camera itself changes; formatting the card removes it."}
                </p>
              </>
            ) : (
              <>
                <div className="row card-row">
                  <span className="subtle">
                    {canPickFolders()
                      ? 'No card chosen. Put it in a card reader, then choose it.'
                      : "This browser can't write to a card: the slots come as a zip to copy onto it, or read the card first to see what it has."}
                  </span>
                  <span className="spacer" />
                  {state.waiting.card && (
                    <button type="button" className="button" onClick={() => void model.reopenWaiting('card')}>
                      Use {state.waiting.card.name} again
                    </button>
                  )}
                  {canPickFolders() ? (
                    <button type="button" className="button" onClick={() => void model.chooseCard()}>
                      Choose card…
                    </button>
                  ) : (
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
                  )}
                  <button type="button" className="button safelight" onClick={() => void model.writeSlotsToCard()}>
                    Download for the card
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </section>
  )
}

/** One slot: the sample photo with the slot's recipe on it, the recipe to pick, and whether the
 *  card already has it. */
function SlotCard({ slot }: { slot: SlotName }) {
  const state = useModel()
  const name = state.slots[slot]
  const stored = name ? model.recipeNamed(name) : undefined
  const wanted = stored ? storedText(stored) : undefined
  const onCard = state.cardSlots?.[slot]
  const sample = model.sample()
  const id = `slot-${slot}`
  return (
    <article className="tile slot" aria-labelledby={`${id}-label`}>
      <div className="tile-picture">
        {stored ? <Thumbnail photo={sample} recipe={wanted ?? null} size={900} /> : <span className="slot-empty">Empty</span>}
        <span className="badge slot-badge" id={`${id}-label`}>
          {slot}
        </span>
        {state.cardSlots !== null &&
          (wanted === onCard ? (
            wanted !== undefined && (
              <span className="slot-state">
                <EdgePrint tone="subtle">on card</EdgePrint>
              </span>
            )
          ) : (
            <span className="slot-state">
              <EdgePrint tone="safelight">not on card yet</EdgePrint>
            </span>
          ))}
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
