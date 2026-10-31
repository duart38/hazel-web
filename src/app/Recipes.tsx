// Browsing recipes: your own, the ones that come with Hazel, and Recently deleted, each shown on
// one of your photos. Picking one opens it in the Studio; an included one is copied first, so the
// original always stays as it came.

import { useState, type ReactNode } from 'react'
import { daysLeft, storedText, type DeletedRecipe, type IncludedRecipe, type StoredRecipe } from '../core/library'
import { recipeNotes, unsupportedSettings } from '../core/recipe'
import { pickFiles } from './folders'
import { model, useModel } from './model'
import { SamplePicker } from './SamplePicker'
import { ShareSheet } from './ShareSheet'
import { Confirm, Menu, Prompt } from './ui/overlays'
import { Thumbnail } from './ui/pictures'
import { EdgePrint } from './ui/theme'

export function Recipes() {
  const state = useModel()
  const [sharing, setSharing] = useState<StoredRecipe | null>(null)
  const [renaming, setRenaming] = useState<StoredRecipe | null>(null)
  const [removing, setRemoving] = useState<DeletedRecipe | null>(null)

  const editCopy = async (included: IncludedRecipe) => {
    const stored = await model.add(included)
    if (stored) model.edit(stored)
  }

  return (
    <section className="screen recipes" aria-labelledby="recipes-title">
      <header className="toolbar">
        <h1 id="recipes-title" className="toolbar-title">
          Recipes
        </h1>
        <button
          type="button"
          className="button"
          onClick={async () => {
            const files = await pickFiles({ accept: '.txt,text/plain', multiple: true })
            if (files.length > 0) await model.importRecipes(files)
          }}
          title="Add recipe files (.txt, the camera's own format) to your recipes"
        >
          Import…
        </button>
        <button type="button" className="button" onClick={() => void model.exportLibrary()} title="Every recipe of yours and slots.txt, in one zip">
          Export all
        </button>
      </header>
      <div className="scroll">
        <div className="page">
          <p className="subtle">Pick a recipe to edit it in the Studio. The ones that come with Hazel stay as they are: editing one makes your own copy.</p>
          <SamplePicker />

          <section aria-labelledby="yours-title" className="group">
            <div className="group-head">
              <h2 id="yours-title">
                <EdgePrint>Yours</EdgePrint>
              </h2>
              <button
                type="button"
                className="button"
                onClick={async () => {
                  const stored = await model.newRecipe()
                  if (stored) model.edit(stored)
                }}
              >
                New recipe
              </button>
            </div>
            <div className="tile-grid">
              {state.recipes.map((stored) => (
                <RecipeTile key={stored.file} name={stored.name} recipe={storedText(stored)} badge={model.slotOf(stored.name)} onOpen={() => model.edit(stored)}>
                  <button type="button" className="button primary" onClick={() => model.edit(stored)}>
                    Edit
                  </button>
                  <Menu
                    label={`More for ${stored.name}`}
                    items={[
                      { label: 'Rename…', run: () => setRenaming(stored) },
                      { label: 'Duplicate', run: () => void model.duplicate(stored) },
                      { label: 'Save as file', run: () => model.exportRecipe(stored) },
                      { label: 'Share with everyone…', run: () => setSharing(stored) },
                      'divider',
                      { label: 'Delete', danger: true, run: () => void model.delete(stored) },
                    ]}
                  />
                </RecipeTile>
              ))}
            </div>
          </section>

          <section aria-labelledby="included-title" className="group">
            <div className="group-head">
              <h2 id="included-title">
                <EdgePrint>Included with Hazel</EdgePrint>
              </h2>
            </div>
            <div className="tile-grid">
              {state.included.map((included) => {
                // made for a newer Hazel: here it would look different from what it should
                const tooNew = unsupportedSettings(included.text, (line) => model.engines.look.recognises(line)).length > 0
                const badge = tooNew ? 'needs a newer Hazel' : model.recipeNamed(included.name) ? 'in yours' : undefined
                return (
                  <RecipeTile key={included.name} name={included.name} recipe={included.text} badge={badge} dimmed={tooNew} onOpen={tooNew ? undefined : () => void editCopy(included)}>
                    <button type="button" className="button" disabled={tooNew} onClick={() => void editCopy(included)}>
                      Edit a copy
                    </button>
                  </RecipeTile>
                )
              })}
            </div>
          </section>

          {state.deleted.length > 0 && (
            <section aria-labelledby="deleted-title" className="group">
              <div className="group-head">
                <h2 id="deleted-title">
                  <EdgePrint>Recently deleted</EdgePrint>
                </h2>
              </div>
              <p className="subtle">Deleted recipes stay here for 30 days.</p>
              <div className="tile-grid">
                {state.deleted.map((deleted) => {
                  const days = daysLeft(deleted)
                  return (
                    <RecipeTile key={deleted.file} name={deleted.name} recipe={storedText(deleted)} badge={`${days} day${days === 1 ? '' : 's'} left`} dimmed onOpen={() => void model.restore(deleted)}>
                      <button type="button" className="button" onClick={() => void model.restore(deleted)}>
                        Restore
                      </button>
                      <Menu label={`More for ${deleted.name}`} items={[{ label: 'Delete for good…', danger: true, run: () => setRemoving(deleted) }]} />
                    </RecipeTile>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      <ShareSheet recipe={sharing} onClose={() => setSharing(null)} />
      <Prompt
        open={renaming !== null}
        title={`Rename ${renaming?.name ?? ''}`}
        label="Name"
        initial={renaming?.name ?? ''}
        action="Rename"
        onDone={(name) => {
          if (renaming && name !== null) void model.rename(renaming, name)
          setRenaming(null)
        }}
      />
      <Confirm
        open={removing !== null}
        title={`Delete ${removing?.name ?? ''} for good?`}
        message="It can't be restored afterwards."
        onCancel={() => setRemoving(null)}
        choices={[
          {
            label: 'Delete for good',
            kind: 'danger',
            run: () => {
              if (removing) void model.removePermanently(removing)
              setRemoving(null)
            },
          },
        ]}
      />
    </section>
  )
}

/** One recipe: the sample photo with it applied, its name and first note, and its buttons. */
function RecipeTile(props: { name: string; recipe: string; badge?: string; dimmed?: boolean; onOpen?: () => void; children: ReactNode }) {
  useModel()
  const sample = model.sample()
  const note = recipeNotes(props.recipe)[0]
  return (
    <article className={`tile${props.dimmed ? ' dimmed' : ''}`} aria-label={props.name}>
      <button type="button" className="tile-picture" onClick={props.onOpen} disabled={!props.onOpen} aria-label={`Open ${props.name}`} tabIndex={-1}>
        <Thumbnail photo={sample} recipe={props.recipe} size={700} />
        {props.badge && <span className="badge">{props.badge}</span>}
      </button>
      <h3 className="tile-name">{props.name}</h3>
      <p className="tile-note subtle">{note ?? ' '}</p>
      <div className="row tight">{props.children}</div>
    </article>
  )
}
