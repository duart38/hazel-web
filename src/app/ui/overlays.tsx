// Sheets, confirmations and menus. A sheet is a modal <dialog> (focus stays inside, Escape
// closes it); on a phone it rises from the bottom.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function Sheet(props: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (props.open && !dialog.open) dialog.showModal()
    if (!props.open && dialog.open) dialog.close()
  }, [props.open])
  return (
    <dialog
      ref={ref}
      className={`sheet${props.wide ? ' wide' : ''} ${props.className ?? ''}`}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onCancel={(event) => {
        event.preventDefault()
        props.onClose()
      }}
      onClick={(event) => {
        // a click on the backdrop (the dialog itself, outside its content) closes it
        if (event.target === ref.current) props.onClose()
      }}
    >
      {props.open && (
        <div className="sheet-body">
          <h2 id={titleId} className="sheet-title">
            {props.title}
          </h2>
          {props.children}
        </div>
      )}
    </dialog>
  )
}

export interface ConfirmChoice {
  label: string
  kind?: 'primary' | 'danger' | 'plain'
  run: () => void
}

/** A question with its answers; Cancel is always there. */
export function Confirm(props: { open: boolean; title: string; message?: string; choices: ConfirmChoice[]; onCancel: () => void }) {
  return (
    <Sheet open={props.open} onClose={props.onCancel} title={props.title} className="confirm">
      {props.message && <p className="subtle">{props.message}</p>}
      <div className="sheet-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          Cancel
        </button>
        {props.choices.map((choice, i) => (
          <button
            key={choice.label}
            type="button"
            className={`button ${choice.kind === 'danger' ? 'danger' : choice.kind === 'primary' ? 'primary' : ''}`}
            autoFocus={i === props.choices.length - 1 && choice.kind !== 'danger'}
            onClick={choice.run}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </Sheet>
  )
}

export interface MenuItem {
  label: string
  run: () => void
  danger?: boolean
  disabled?: boolean
}

/** A "more" button with a short list of actions. Arrow keys move, Escape closes. */
export function Menu({ items, label = 'More', icon = '⋯' }: { items: (MenuItem | 'divider')[]; label?: string; icon?: ReactNode }) {
  const [open, setOpen] = useState(false)
  // where the list opens from: under the button's right edge unless that runs off the screen
  const [place, setPlace] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const menuId = useId()
  useLayoutEffect(() => {
    if (!open) return setPlace('')
    const element = list.current
    // on a phone it's a sheet along the bottom, which always fits
    if (!element || getComputedStyle(element).position === 'fixed') return
    const rect = element.getBoundingClientRect()
    const button = box.current?.getBoundingClientRect()
    const start = rect.left < 8 ? ' start' : ''
    const up = rect.bottom > window.innerHeight - 8 && button !== undefined && button.top - rect.height > 8 ? ' up' : ''
    setPlace(start + up)
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const move = (event: React.KeyboardEvent) => {
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') items[(at + 1) % items.length]?.focus()
    else if (event.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus()
    else if (event.key === 'Escape') {
      setOpen(false)
      box.current?.querySelector<HTMLButtonElement>('.menu-button')?.focus()
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
  return (
    <div className="menu" ref={box} onKeyDown={move}>
      <button
        type="button"
        className="icon-button menu-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open && <div className="menu-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div className={`menu-list${place}`} role="menu" id={menuId} ref={list}>
          {items.map((item, i) =>
            item === 'divider' ? (
              <hr key={`d${i}`} />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.danger ? 'danger' : undefined}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false)
                  item.run()
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

/** A one-field question, such as a new name. */
export function Prompt(props: { open: boolean; title: string; label: string; initial: string; action: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(props.initial)
  useEffect(() => {
    if (props.open) setValue(props.initial)
  }, [props.open, props.initial])
  return (
    <Sheet open={props.open} onClose={() => props.onDone(null)} title={props.title}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          props.onDone(value)
        }}
      >
        <label className="field">
          <span>{props.label}</span>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="sheet-actions">
          <button type="button" className="button" onClick={() => props.onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={value.trim() === ''}>
            {props.action}
          </button>
        </div>
      </form>
    </Sheet>
  )
}
