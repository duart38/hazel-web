// Offering a recipe to Hazel's recipe collection, for everyone's "Included with Hazel": a
// description to add, the recipe as it will be sent, and a button that opens GitHub with it
// filled in. The collection's rules are checked here first, so GitHub never gets one it turns down.

import { useEffect, useState } from 'react'
import { proposalFileName, proposalProblems, proposalRecipe, proposalUrl } from '../core/proposal'
import type { FilmSettings } from '../core/settings'
import { model, useModel } from './model'
import { Sheet } from './ui/overlays'
import { EdgePrint } from './ui/theme'

export function ShareSheet({ recipe, onClose }: { recipe: { name: string; settings: FilmSettings } | null; onClose: () => void }) {
  const state = useModel()
  const [description, setDescription] = useState('')
  useEffect(() => {
    if (recipe) setDescription(recipe.settings.notes[0] ?? '')
  }, [recipe])
  const name = recipe?.name ?? ''
  const text = recipe ? proposalRecipe(name, recipe.settings, description) : ''
  const problems = recipe ? proposalProblems(text, state.included.map((r) => r.name)) : []
  const openGitHub = () => {
    if (problems.length > 0) return
    window.open(proposalUrl(text), '_blank', 'noopener,noreferrer')
    model.notify(`${name} is open on GitHub: sign in and press Propose changes`)
    onClose()
  }
  return (
    <Sheet open={recipe !== null} onClose={onClose} title={`Share ${name}`}>
      <p className="subtle">
        Once it's accepted, everyone with Hazel finds it under Included with Hazel. GitHub opens with your recipe filled in: sign in (an account is free) and
        press Propose changes, then Create pull request. It's checked before it goes in, and you can follow it on GitHub.
      </p>
      <label className="field">
        <EdgePrint>Description</EdgePrint>
        <input
          value={description}
          placeholder="What the look is, in one line"
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            openGitHub()
          }}
        />
        <span className="subtle small">Inspired by a film? Say so here: "Inspired by Portra 400".</span>
      </label>
      <div className="field">
        <EdgePrint>{proposalFileName(name)}</EdgePrint>
        <pre className="recipe-text" tabIndex={0} aria-label="The recipe as it will be sent">
          {text}
        </pre>
      </div>
      {problems.length > 0 && (
        <ul className="problems" aria-live="polite">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="sheet-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={problems.length > 0}
          onClick={openGitHub}
        >
          Open GitHub
        </button>
      </div>
    </Sheet>
  )
}
