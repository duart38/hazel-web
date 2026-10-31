// Which photo the Recipes and Camera tabs show recipes on: any photo open in the Darkroom, or
// another file.

import { pickFiles, pickPhotoHandle } from './folders'
import { model, useModel } from './model'
import { Thumbnail } from './ui/pictures'
import { EdgePrint } from './ui/theme'

export function SamplePicker() {
  const state = useModel()
  const sample = model.sample()
  const other = state.otherSample && !state.photos.some((p) => p.key === state.otherSample?.key) ? state.otherSample : null
  return (
    <div className="sample-picker">
      <EdgePrint tone="subtle">Shown on</EdgePrint>
      <div className="sample-strip" role="group" aria-label="Photo to show recipes on">
        {other && (
          <button type="button" className={`sample${sample?.key === other.key ? ' selected' : ''}`} aria-pressed={sample?.key === other.key} title={other.name} onClick={() => model.useOther()}>
            <Thumbnail photo={other} recipe={null} size={240} alt={other.name} />
          </button>
        )}
        {state.photos.map((photo) => (
          <button
            key={photo.key}
            type="button"
            className={`sample${sample?.key === photo.key ? ' selected' : ''}`}
            aria-pressed={sample?.key === photo.key}
            title={photo.name}
            onClick={() => model.useSample(photo)}
          >
            <Thumbnail photo={photo} recipe={null} size={240} alt={photo.name} />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="button"
        onClick={async () => {
          const handle = await pickPhotoHandle().catch(() => undefined)
          if (handle) return void model.useOtherSample(await handle.getFile(), handle)
          if (handle === null) return
          const [file] = await pickFiles({ accept: '.3fr,.3FR,.fff,.dng,image/*' })
          if (file) void model.useOtherSample(file)
        }}
      >
        Other photo…
      </button>
    </div>
  )
}
