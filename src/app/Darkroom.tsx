// Your photos as a contact sheet, each shown with the look the camera had when it was taken; one
// photo large, with a filmstrip of the others to pick from.

import { useEffect, useMemo, useRef, useState } from 'react'
import { EXPORT_FORMATS, type ExportFormat } from '../core/photos'
import type { DevelopedImage } from '../engine/types'
import { canPickFolders, pickFiles } from './folders'
import { model, useModel, type AppPhoto, type LookChoice } from './model'
import { FULL_SIZE, isAbort, toBitmap } from './render'
import { noiseReductionStep } from '../core/settings'
import { SelectBox } from './ui/controls'
import { Menu, type MenuItem } from './ui/overlays'
import { FIT, fitted, isZoomed, useElementSize, useZoomKeys, type Zoom } from './ui/hooks'
import { LiveLook } from './ui/live'
import { BitmapView, ShootingInfoBar, Thumbnail, Zoomable } from './ui/pictures'
import { EdgePrint, Spinner } from './ui/theme'

export function Darkroom() {
  const state = useModel()
  const [open, setOpen] = useState<string | null>(null)
  const [lastShown, setLastShown] = useState<string | null>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const photo = state.photos.find((p) => p.key === open) ?? null

  // back from the large view: the photo you were last on, which may be far from the one opened
  useEffect(() => {
    if (open === null && lastShown) sheet.current?.querySelector(`[data-key="${CSS.escape(lastShown)}"]`)?.scrollIntoView({ block: 'center' })
  }, [open, lastShown])

  if (photo) {
    return (
      <PhotoViewer
        start={photo}
        onClose={() => setOpen(null)}
        onShown={(key) => setLastShown(key)}
      />
    )
  }

  return (
    <section className="screen darkroom" aria-labelledby="darkroom-title">
      <header className="toolbar">
        <h1 id="darkroom-title" className="toolbar-title">
          {model.folderTitle()}
        </h1>
        <FolderMenu />
        {state.photos.length > 0 && (
          <button
            type="button"
            className="button"
            disabled={state.exporting !== null}
            title={`Develop every photo with its look and save it${state.exportFolder ? ` to ${state.exportFolder.name}` : ''}`}
            onClick={() => void model.export(state.photos)}
          >
            {state.exporting ? `Exporting ${state.exporting.done}/${state.exporting.total}…` : 'Export all'}
          </button>
        )}
      </header>
      {state.photosLoading ? (
        <div className="empty">
          <Spinner label="Reading the folder" />
        </div>
      ) : state.photos.length === 0 ? (
        <EmptyDarkroom />
      ) : (
        <div className="contact-sheet" ref={sheet}>
          {state.photos.map((p, index) => (
            <button key={p.key} type="button" className="frame" data-key={p.key} onClick={() => setOpen(p.key)} aria-label={`${p.name}, ${model.shortLabel(p)}`}>
              <span className="frame-picture">
                <Thumbnail photo={p} recipe={model.recipeFor(p)} size={640} />
              </span>
              <span className="frame-edge">
                <EdgePrint>▸ {index + 1}</EdgePrint>
                <EdgePrint tone="subtle">{p.base}</EdgePrint>
                <span className="spacer" />
                <EdgePrint>{model.shortLabel(p)}</EdgePrint>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function FolderMenu() {
  const state = useModel()
  const source = state.source
  const items: (MenuItem | 'divider')[] = []
  if (source?.isCard) {
    for (const folder of source.photoFolders) {
      items.push({ label: `${source.root.name} · ${folder}${folder === source.current ? ' ✓' : ''}`, run: () => void model.showPhotoFolder(folder) })
    }
    items.push('divider')
  }
  if (state.waiting.source) items.push({ label: `Open ${state.waiting.source.name} again`, run: () => void model.reopenWaiting('source') })
  if (canPickFolders()) items.push({ label: 'Open card or folder…', run: () => void model.chooseFolder() })
  items.push({ label: canPickFolders() ? 'Pick photos from a folder (read only)…' : 'Open card or folder…', run: () => void pickFolderFiles() })
  if (!canPickFolders()) items.push({ label: PICK_PHOTOS, run: () => void pickPhotoFiles() })
  if (state.exportFolder) items.push({ label: `Exports go to ${state.exportFolder.name}: change…`, run: () => void model.chooseExportFolder() })
  return <Menu items={items} label="Photos: open a card or folder" icon={<span className="menu-text">Photos ▾</span>} />
}

async function pickFolderFiles() {
  const files = await pickFiles({ directory: true })
  if (files.length > 0) await model.openFileList(files)
}

const PICK_PHOTOS = 'Pick photos and their .look files…'
const ORIGINAL = 'Original (no look)'

/** Safari on an iPhone or iPad can't pick a folder, only files: pick the photos with their
 *  sidecars, and they're shown as one folder. */
async function pickPhotoFiles() {
  const files = await pickFiles({ multiple: true })
  if (files.length > 0) await model.openFileList(files)
}

function EmptyDarkroom() {
  const state = useModel()
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        ▤
      </div>
      <h2>Put the camera's card in, or open a folder of photos</h2>
      <p className="subtle">
        Raw files (.3FR) and JPEGs. Photos taken with the film look on have a .look file next to them, and are shown with that look.
      </p>
      <div className="row">
        {state.waiting.source && (
          <button type="button" className="button primary" onClick={() => void model.reopenWaiting('source')}>
            Open {state.waiting.source.name} again
          </button>
        )}
        {canPickFolders() ? (
          <button type="button" className={`button${state.waiting.source ? '' : ' primary'}`} onClick={() => void model.chooseFolder()}>
            Open card or folder…
          </button>
        ) : (
          <button type="button" className="button primary" onClick={() => void pickFolderFiles()}>
            Open card or folder…
          </button>
        )}
      </div>
      {!canPickFolders() && (
        <>
          <button type="button" className="link-button" onClick={() => void pickPhotoFiles()}>
            {PICK_PHOTOS}
          </button>
          <p className="subtle small">This browser can read the card but not write to it: recipes for the camera come as a zip to copy onto the card.</p>
        </>
      )}
    </div>
  )
}

/** One photo large, with the folder's photos in a strip along the bottom. The arrow keys go to
 *  the previous and next photo. */
function PhotoViewer({ start, onClose, onShown }: { start: AppPhoto; onClose: () => void; onShown: (key: string) => void }) {
  const state = useModel()
  const [key, setKey] = useState(start.key)
  const index = state.photos.findIndex((p) => p.key === key)
  const photo = state.photos[index] ?? start

  useEffect(() => onShown(photo.key), [photo.key, onShown])

  const step = (by: number) => {
    const next = state.photos[index + by]
    if (next) setKey(next.key)
  }

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return
      if (document.querySelector('dialog[open]') || model.state.place !== 'darkroom') return
      if (event.key === 'ArrowLeft') step(-1)
      else if (event.key === 'ArrowRight') step(1)
      else if (event.key === 'Escape') onClose()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  })

  return (
    <section className="screen viewer" aria-label={photo.name}>
      <header className="toolbar">
        <button type="button" className="button" onClick={onClose} title="Back to the contact sheet (Escape)" aria-label={`Back to ${model.folderTitle()}`}>
          ‹ <span className="wide-only">{model.folderTitle()}</span>
        </button>
        <h1 className="toolbar-title">{photo.name}</h1>
        <div className="row tight">
          <button type="button" className="icon-button" onClick={() => step(-1)} disabled={index <= 0} aria-label="Previous photo" title="Previous photo (←)">
            ‹
          </button>
          <span className="mono subtle">
            {index + 1} of {state.photos.length}
          </span>
          <button type="button" className="icon-button" onClick={() => step(1)} disabled={index >= state.photos.length - 1} aria-label="Next photo" title="Next photo (→)">
            ›
          </button>
        </div>
      </header>
      {/* a new view per photo, so its zoom and pictures start afresh */}
      <PhotoView key={photo.key} photo={photo} />
      {state.photos.length > 1 && <Filmstrip photos={state.photos} current={photo.key} onPick={setKey} />}
    </section>
  )
}

/** The folder's photos in a row, each with its look, like a strip of negatives on the light box. */
function Filmstrip({ photos, current, onPick }: { photos: AppPhoto[]; current: string; onPick: (key: string) => void }) {
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    strip.current?.querySelector(`[data-key="${CSS.escape(current)}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [current])
  return (
    <nav className="filmstrip" ref={strip} aria-label="Photos in this folder">
      {photos.map((p, i) => {
        const selected = p.key === current
        return (
          <button key={p.key} type="button" data-key={p.key} className={`filmstrip-frame${selected ? ' selected' : ''}`} aria-current={selected ? 'true' : undefined} title={p.name} onClick={() => onPick(p.key)}>
            {/* the contact sheet's size, so the two share the pictures already made */}
            <span className="filmstrip-picture">
              <Thumbnail photo={p} recipe={model.recipeFor(p)} size={640} alt={p.name} />
            </span>
            <EdgePrint tone={selected ? 'amber' : 'subtle'}>▸ {i + 1}</EdgePrint>
          </button>
        )
      })}
    </nav>
  )
}

interface Shown {
  bitmap: ImageBitmap
  original: ImageBitmap | null
  /** the look `bitmap` has (the recipe text, or none) */
  lookKey: string
}

/** One photo, large. Hold the picture to see it without the look. */
function PhotoView({ photo }: { photo: AppPhoto }) {
  const state = useModel()
  const choice = model.choice(photo)
  const recipe = model.recipeFor(photo, choice)
  const [shown, setShown] = useState<Shown | null>(null)
  // the development the look goes on, for the GPU while the engine works on a newly picked look
  const [screen, setScreen] = useState<DevelopedImage | null>(null)
  const [fullImage, setFullImage] = useState<DevelopedImage | null>(null)
  const look = useMemo(() => model.lookOf(recipe), [recipe])
  const lookKey = recipe ?? ''
  const [comparing, setComparing] = useState(false)
  const [developing, setDeveloping] = useState(true)
  const [zoom, setZoom] = useState<Zoom>(FIT)
  const [fullWidth, setFullWidth] = useState<number | undefined>()
  const [box, boxSize] = useElementSize<HTMLDivElement>()
  const full = isZoomed(zoom)
  const aspect = shown ? shown.bitmap.width / shown.bitmap.height : 3 / 2
  const size = fitted(aspect, boxSize)
  useZoomKeys(state.place === 'darkroom', zoom, setZoom, size, fullWidth)

  useEffect(() => {
    let current = true
    const run = async () => {
      setDeveloping(true)
      try {
        const info = await model.renderer.info(photo)
        if (current) setFullWidth(info.width)
        // the camera's own preview first (instant), then a real development of the raw
        if (!shown) {
          const quick = await model.renderer.embedded(photo, 1440)
          const quickBitmap = await toBitmap(await model.renderer.look(quick, look))
          if (current) setShown({ bitmap: quickBitmap, original: null, lookKey })
        }
        const noise = recipe ? noiseReductionStep(model.readSettings(recipe)) : 0
        const developed: DevelopedImage = await model.renderer.developed(photo, full ? FULL_SIZE : 2600, noise)
        if (!current) return
        if (full) setFullImage(developed)
        else setScreen(developed)
        const looked = await model.renderer.latest('viewer', developed, look)
        if (!looked || !current) return
        const bitmap = await toBitmap(looked)
        if (!current) return
        setShown((old) => ({ bitmap, original: old?.original ?? null, lookKey }))
        const plain = noise === 0 ? developed : await model.renderer.developed(photo, full ? FULL_SIZE : 2600, 0)
        const original = await toBitmap(plain)
        if (current) setShown({ bitmap, original, lookKey })
      } catch (error) {
        if (!isAbort(error)) {
          console.error(error)
          if (current) model.notify(`Couldn't develop ${photo.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      } finally {
        if (current) setDeveloping(false)
      }
    }
    void run()
    return () => {
      current = false
    }
    // `shown` is only read to skip the quick preview once there's a picture
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, recipe, look, full])

  const keepable = model.keepableLook(photo)
  const value = choice
  const lookName = (v: string) => (v === 'asShot' ? model.label('asShot', photo) : v === 'original' ? ORIGINAL : v.replace(/^recipe:/, ''))
  return (
    <>
      <ShootingInfoBar photo={photo} />
      <div className="picture-box" ref={box}>
        {shown && size.width > 0 && (
          <Zoomable
            zoom={zoom}
            setZoom={setZoom}
            size={size}
            fullPixels={fullWidth}
            onHold={setComparing}
            label={`${photo.name}. Pinch, scroll or double-click to zoom. Press and hold to see it without the look.`}
            overlay={
              <>
                <LiveLook
                  screen={screen}
                  full={full ? fullImage : null}
                  look={look}
                  lookKey={lookKey}
                  show={shown.lookKey !== lookKey && !comparing}
                  zoom={zoom}
                  size={size}
                />
                <div className="picture-badges" aria-hidden="true">
                  {comparing && <EdgePrint tone="white">original</EdgePrint>}
                </div>
              </>
            }
          >
            <BitmapView bitmap={comparing && shown.original ? shown.original : shown.bitmap} className="picture" />
          </Zoomable>
        )}
        {developing && (
          <span className="developing">
            <Spinner label="Developing" />
          </span>
        )}
      </div>
      <footer className="viewer-bar">
        <SelectBox className="look-select" label="Look" value={value} shown={lookName(value)} onChange={(v) => model.setChoice(photo, v as LookChoice)}>
          <option value="asShot">{model.label('asShot', photo)}</option>
          <option value="original">{ORIGINAL}</option>
          <optgroup label="Your recipes">
            {state.recipes.map((r) => (
              <option key={r.file} value={`recipe:${r.name}`}>
                {r.name}
              </option>
            ))}
          </optgroup>
        </SelectBox>
        <button
          type="button"
          className="button compare-button"
          onPointerDown={() => setComparing(true)}
          onPointerUp={() => setComparing(false)}
          onPointerLeave={() => setComparing(false)}
          onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && setComparing(true)}
          onKeyUp={() => setComparing(false)}
          title="Hold to see the photo without the look"
        >
          Hold to compare
        </button>
        {keepable && (
          <button type="button" className="button" onClick={() => void model.keepLook(photo)} title="Add the recipe this photo was taken with to your recipes">
            Keep this look
          </button>
        )}
        <span className="spacer" />
        <ExportControls photos={[photo]} />
      </footer>
    </>
  )
}

export function ExportControls({ photos }: { photos: AppPhoto[] }) {
  const state = useModel()
  const formats = useMemo(() => EXPORT_FORMATS, [])
  return (
    <div className="row tight">
      <SelectBox
        className="format-select"
        label="Export format"
        value={state.exportFormat}
        shown={formats.find((f) => f.id === state.exportFormat)?.name ?? ''}
        onChange={(v) => model.setExportFormat(v as ExportFormat)}
      >
        {formats.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </SelectBox>
      <button type="button" className="button primary" disabled={state.exporting !== null} onClick={() => void model.export(photos)}>
        {state.exporting ? `Exporting ${state.exporting.done}/${state.exporting.total}…` : 'Export'}
      </button>
    </div>
  )
}
