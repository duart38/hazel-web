// Picking one of many by how it looks: a button with the current one's picture and name, which
// opens a searchable grid of pictures. Only the pictures scrolled into view are made, so it stays
// quick with thousands. Return picks the first match.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Sheet } from './overlays'

export function PicturePicker<T>(props: {
  /** what the items are, plural: "films", "photos" */
  kind: string
  items: T[]
  current: T | null
  id: (item: T) => string
  name: (item: T) => string
  /** searched as well as the name */
  detail?: (item: T) => string | undefined
  thumbnail: (item: T) => ReactNode
  onPick: (item: T) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const grid = useRef<HTMLDivElement>(null)
  const query = search.trim().toLocaleLowerCase()
  const shown = query === '' ? props.items : props.items.filter((item) => props.name(item).toLocaleLowerCase().includes(query) || (props.detail?.(item) ?? '').toLocaleLowerCase().includes(query))
  const currentId = props.current === null ? null : props.id(props.current)

  useEffect(() => {
    if (open) grid.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' })
  }, [open])

  const choose = (item: T) => {
    props.onPick(item)
    setOpen(false)
    setSearch('')
  }

  return (
    <>
      <button type="button" className="picture-picker" onClick={() => setOpen(true)} title={`Choose from ${props.items.length} ${props.kind}`}>
        {props.current !== null && <span className="picture-picker-thumb">{props.thumbnail(props.current)}</span>}
        <span className="picture-picker-text">
          <span className="picture-picker-name">{props.current === null ? 'Choose…' : props.name(props.current)}</span>
          <span className="subtle small">
            {props.items.length} {props.kind}
          </span>
        </span>
        <span aria-hidden="true" className="subtle">
          ⌄
        </span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Choose from ${props.items.length} ${props.kind}`} wide>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (shown[0] !== undefined) choose(shown[0])
          }}
        >
          <input
            className="search"
            type="search"
            autoFocus
            placeholder={`Search ${props.items.length} ${props.kind}`}
            aria-label={`Search ${props.kind}`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // a search field's own Escape only empties it; here it closes the picker, as elsewhere
              if (e.key !== 'Escape') return
              e.preventDefault()
              setOpen(false)
              setSearch('')
            }}
          />
        </form>
        <div className="picker-grid" ref={grid}>
          {shown.map((item) => {
            const selected = props.id(item) === currentId
            return (
              <button key={props.id(item)} type="button" className={`picker-cell${selected ? ' selected' : ''}`} aria-current={selected ? 'true' : undefined} onClick={() => choose(item)}>
                <span className="picker-cell-thumb">{props.thumbnail(item)}</span>
                <span className="picker-cell-name">{props.name(item)}</span>
              </button>
            )
          })}
          {shown.length === 0 && (
            <p className="subtle">
              No {props.kind} match “{search}”.
            </p>
          )}
        </div>
      </Sheet>
    </>
  )
}
