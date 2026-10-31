// Putting Hazel on the camera from the browser, over the camera's USB cable: connect, see what the
// camera has and which Hazel is newest, then install, update or remove. Needs WebUSB (Chrome or
// Edge on a computer).

import { useEffect, useRef, useState } from 'react'
import { CameraLink, CameraTimeout } from '../camera/link'
import { archiveVersion, fetchFirmware, inspect, install, remove, type CameraState, type Firmware } from '../camera/installer'
import { PRODUCT_ID, VENDOR_ID } from '../camera/protocol'
import { Confirm } from './ui/overlays'
import { EdgePrint } from './ui/theme'

const FIRMWARE_REPO = 'https://github.com/duart38/Hazel-firmware'
const FIRMWARE_SOURCE: string | undefined = import.meta.env.VITE_HAZEL_FIRMWARE

type Action = 'install' | 'remove'

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ready'; camera: CameraState; newest: string | null }
  | { kind: 'working'; action: Action; steps: string[] }
  | { kind: 'done'; action: Action; steps: string[] }
  | { kind: 'failed'; message: string; steps?: string[] }

export function InstallHazel() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [asking, setAsking] = useState<Action | null>(null)
  const link = useRef<CameraLink | null>(null)
  const firmware = useRef<Firmware | null>(null)
  const supported = typeof navigator !== 'undefined' && 'usb' in navigator

  useEffect(() => {
    if (!supported) return
    const gone = (event: USBConnectionEvent) => {
      if (link.current?.device !== event.device) return
      link.current = null
      setPhase((p) => (p.kind === 'done' ? p : { kind: 'failed', message: 'The camera was disconnected. Connect it again and press Connect.' }))
    }
    navigator.usb.addEventListener('disconnect', gone)
    return () => {
      navigator.usb.removeEventListener('disconnect', gone)
      void link.current?.close()
    }
  }, [supported])

  const connect = async () => {
    try {
      const device = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] })
      setPhase({ kind: 'checking' })
      await link.current?.close()
      link.current = await CameraLink.open(device)
      firmware.current = await fetchFirmware(FIRMWARE_SOURCE)
      setPhase({ kind: 'ready', camera: await inspect(link.current, firmware.current), newest: archiveVersion(firmware.current.archive) })
    } catch (error) {
      // closing the chooser without picking the camera
      if (error instanceof DOMException && error.name === 'NotFoundError') return setPhase({ kind: 'idle' })
      setPhase({ kind: 'failed', message: explain(error) })
    }
  }

  const run = async (action: Action, allowServiceInstall = false) => {
    setAsking(null)
    const current = link.current
    const files = firmware.current
    if (!current || !files) return
    const steps: string[] = []
    const onStep = (step: string) => {
      steps.push(step)
      setPhase({ kind: 'working', action, steps: [...steps] })
    }
    setPhase({ kind: 'working', action, steps })
    try {
      if (action === 'install') await install(current, files, { allowServiceInstall, onStep })
      else await remove(current, onStep)
      setPhase({ kind: 'done', action, steps: [...steps] })
    } catch (error) {
      setPhase({ kind: 'failed', message: explain(error), steps: [...steps] })
    }
  }

  return (
    <section className="group" aria-labelledby="install-title">
      <h2 id="install-title">
        <EdgePrint tone="safelight">Hazel on the camera</EdgePrint>
      </h2>
      {!supported ? (
        <p className="subtle">
          Installing Hazel from here needs Chrome or Edge on a computer, which can talk to the camera over its USB cable. This browser can't. Open this page in Chrome or Edge, or follow the steps for
          the Terminal in <a href={FIRMWARE_REPO}>Hazel-firmware</a>.
        </p>
      ) : (
        <div className="install">
          {phase.kind === 'idle' && (
            <>
              <ol className="install-steps">
                <li>Put a memory card in the camera and turn it on.</li>
                <li>Connect it to this computer with its USB-C cable.</li>
                <li>Press Connect, choose X1D-50c, then Connect again.</li>
              </ol>
              <div className="row">
                <button type="button" className="button primary" onClick={() => void connect()}>
                  Connect…
                </button>
                <span className="subtle small">To install, update or remove Hazel. Nothing changes on the camera until you choose.</span>
              </div>
            </>
          )}

          {phase.kind === 'checking' && (
            <div className="row">
              <span className="spinner" aria-hidden="true" />
              <span>Looking at the camera…</span>
            </div>
          )}

          {phase.kind === 'ready' && <Ready camera={phase.camera} newest={phase.newest} onInstall={() => (phase.camera.serviceCurrent ? void run('install') : setAsking('install'))} onRemove={() => setAsking('remove')} onRecheck={() => void connect()} />}

          {(phase.kind === 'working' || phase.kind === 'done') && (
            <ul className="install-checks" aria-live="polite">
              {phase.steps.map((step, i) => (
                <Check key={step} ok={phase.kind === 'done' || i < phase.steps.length - 1} busy={phase.kind === 'working' && i === phase.steps.length - 1} text={step} />
              ))}
            </ul>
          )}

          {phase.kind === 'done' && (
            <div className="install-done">
              {phase.action === 'install' ? (
                <>
                  <strong>Hazel is on the camera.</strong>
                  <p>Turn the camera off and on again. Hazel starts a few seconds after live view does. Choose a recipe under Settings, Extras, and pick the recipes for C1 to C7 below.</p>
                </>
              ) : (
                <>
                  <strong>Hazel is removed.</strong>
                  <p>Turn the camera off and on again and it starts as it came from Hasselblad. Your photos and the recipes on the card are still there.</p>
                </>
              )}
            </div>
          )}

          {phase.kind === 'failed' && (
            <>
              {phase.steps && phase.steps.length > 0 && (
                <ul className="install-checks">
                  {phase.steps.map((step, i, all) => (
                    <Check key={step} ok={i < all.length - 1} text={step} />
                  ))}
                </ul>
              )}
              <p className="install-error" role="alert">
                {phase.message}
              </p>
              <div className="row">
                <button type="button" className="button primary" onClick={() => void connect()}>
                  Connect again…
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <Confirm
        open={asking === 'install'}
        title="Let the camera start Hazel?"
        message="This is the one lasting change: two small files in the camera's own system, so that it runs Hazel from the memory card each time it turns on. Without the card it starts as normal. Remove Hazel here undoes it, and a firmware update removes it too."
        choices={[{ label: 'Allow and install', kind: 'primary', run: () => void run('install', true) }]}
        onCancel={() => setAsking(null)}
      />
      <Confirm
        open={asking === 'remove'}
        title="Remove Hazel from the camera?"
        message="Removes the files that start Hazel from the camera, and Hazel itself from the memory card. Your photos and the recipes on the card stay. Hazel keeps running until you turn the camera off."
        choices={[{ label: 'Remove Hazel', kind: 'danger', run: () => void run('remove') }]}
        onCancel={() => setAsking(null)}
      />
    </section>
  )
}

function Ready({ camera, newest, onInstall, onRemove, onRecheck }: { camera: CameraState; newest: string | null; onInstall: () => void; onRemove: () => void; onRecheck: () => void }) {
  const set = camera.serviceCurrent && camera.bootScriptCurrent && camera.hasKey
  const upToDate = set && newest !== null && camera.running === newest
  const label = !set ? 'Install Hazel' : upToDate ? 'Install again' : 'Update Hazel'
  return (
    <>
      <ul className="install-checks" aria-label="What the camera has">
        <Check ok={camera.supported} text={camera.supported ? 'Firmware 1.25.0' : `Firmware ${camera.firmware}: Hazel only works with 1.25.0`} />
        <Check ok={camera.cards.length > 0} text={camera.cards.length > 0 ? 'Memory card in the camera' : 'No memory card: put one in, then connect again'} />
        <Check ok={set} pending text={set ? 'Starts Hazel when it turns on' : 'Not set up to start Hazel yet'} />
        {camera.running && <Check ok pending text={`Running ${short(camera.running)}`} />}
        {newest && <Check ok={upToDate} pending text={upToDate ? 'That is the newest Hazel' : `Newest: ${short(newest)}`} />}
      </ul>
      <div className="row">
        <button type="button" className={`button ${upToDate ? '' : 'safelight'}`} disabled={!camera.supported || camera.cards.length === 0} onClick={onInstall}>
          {label}
        </button>
        <button type="button" className="button" onClick={onRecheck}>
          Check again
        </button>
        <span className="subtle small">Takes about half a minute. Keep the camera on and connected.</span>
        <span className="spacer" />
        {camera.installed && (
          <button type="button" className="button danger" onClick={onRemove}>
            Remove Hazel…
          </button>
        )}
      </div>
    </>
  )
}

/** "Hazel 9bfeea7 built 2026-10-31" as "Hazel 9bfeea7, 31 Oct 2026" */
function short(version: string): string {
  const m = version.match(/^(.*?) built (\d{4}-\d{2}-\d{2})$/)
  if (!m) return version
  const date = new Date(`${m[2]}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return `${m[1]}, ${date}`
}

function Check({ ok, text, busy, pending }: { ok: boolean; text: string; busy?: boolean; pending?: boolean }) {
  const mark = busy ? <span className="spinner small-spinner" aria-hidden="true" /> : ok ? '✓' : pending ? '○' : '✕'
  const tone = busy ? '' : ok ? 'is-ok' : pending ? 'is-pending' : 'is-bad'
  return (
    <li className={tone}>
      <span className="install-mark" aria-hidden="true">
        {mark}
      </span>
      <span>{text}</span>
    </li>
  )
}

function explain(error: unknown): string {
  if (error instanceof CameraTimeout) return 'The camera stopped answering. Check that it is on and the cable is in, then connect again.'
  if (error instanceof DOMException && error.name === 'SecurityError') return 'The browser did not allow the connection. Connect again and choose X1D-50c.'
  if (error instanceof DOMException && (error.name === 'NetworkError' || error.name === 'InvalidStateError'))
    return 'The camera is busy with another program. Close any Terminal window talking to it, then connect again.'
  const message = error instanceof Error ? error.message : String(error)
  if (/arrived damaged|doesn’t match/.test(message))
    return 'A file didn’t reach the camera intact, so it was not used. The camera works as before. Connect again and try once more.'
  return message.charAt(0).toUpperCase() + message.slice(1) + '.'
}
