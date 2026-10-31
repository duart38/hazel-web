// Puts Hazel on a camera over USB, the same steps as Catkin's `install` and `card --usb`
// (Hazel-firmware's catkin): a key and the start script on the camera's data partition, the
// start-up service on its system partition (the one permanent change, only with permission), and
// the card setup, sealed with the camera's key, at the top of the memory card.

import { type CameraLink, sha256Hex } from './link'

/** firmware 1.25.0, the only one Hazel's programs are built for */
export const SUPPORTED_FIRMWARE = '20201022080843'

const HOME = '/media/data/x1d-card-loader'
const UNIT = 'x1d-card-loader.service'
const UNIT_PATH = `/etc/systemd/system/${UNIT}`
const WANTS_PATH = `/etc/systemd/system/late.target.wants/${UNIT}`
/** where the link was before the loader started with live view; installing clears it */
const OLD_WANTS_PATH = `/etc/systemd/system/verylate.target.wants/${UNIT}`
const STORAGE = 'busctl --system --timeout=60 call com.hasselblad.storage / com.hasselblad.storage'
const TAR = 'CATKIN.TAR'
const SIG = 'CATKIN.SIG'

/** what goes on the camera, from Hazel-firmware */
export interface Firmware {
  /** the card setup, unsealed (release/hazel.tar) */
  archive: Uint8Array<ArrayBuffer>
  bootScript: Uint8Array<ArrayBuffer>
  unit: Uint8Array<ArrayBuffer>
  /** the upload helper, camera/unb64 */
  helper: Uint8Array<ArrayBuffer>
}

export const FIRMWARE_SOURCE = 'https://raw.githubusercontent.com/duart38/Hazel-firmware/main'

export async function fetchFirmware(base = FIRMWARE_SOURCE): Promise<Firmware> {
  const get = async (path: string) => {
    const response = await fetch(`${base}/${path}`, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`couldn't download ${path} (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  }
  const [archive, bootScript, unit, helper] = await Promise.all([
    get('release/hazel.tar'),
    get('camera/boot.sh'),
    get(`camera/${UNIT}`),
    get('camera/unb64'),
  ])
  return { archive, bootScript, unit, helper }
}

export interface CameraState {
  /** /etc/version, e.g. 20201022080843 for 1.25.0 */
  firmware: string
  supported: boolean
  hasKey: boolean
  bootScriptCurrent: boolean
  /** the start-up service is installed, the current one, and linked to start with live view */
  serviceCurrent: boolean
  /** memory cards in the camera, e.g. ["/SD1"] */
  cards: string[]
  /** any part of the loader is on the camera: the service, its link, or the key and start script */
  installed: boolean
  /** the VERSION of the Hazel running now ("Hazel 9bfeea7 built 2026-10-31"), null when it isn't */
  running: string | null
}

/** Looks, without changing anything. */
export async function inspect(link: CameraLink, firmware: Firmware): Promise<CameraState> {
  const version = (await link.run('cat /etc/version')).trim()
  const hasKey = (await link.run(`k=$(cat ${HOME}/key 2>/dev/null); echo \${#k}`)).trim()
  const sums = await link.sh(`sha256sum ${HOME}/boot.sh ${UNIT_PATH} 2>/dev/null`)
  const sumOf = (path: string) => sums.output.split('\n').find((line) => line.endsWith(` ${path}`))?.split(/\s+/)[0]
  // relative to the systemd folder, to keep the command short
  const found = await link.run(
    `cd /etc/systemd/system; for p in ${UNIT} ${WANTS_PATH.slice(20)} ${OLD_WANTS_PATH.slice(20)} ${HOME}; do [ -e $p ] || [ -L $p ] && echo $p; done; true`,
  )
  const has = (path: string) => found.split('\n').includes(path.startsWith('/etc/systemd/system/') ? path.slice(20) : path)
  const volumes = await link.sh('busctl --system get-property com.hasselblad.storage / com.hasselblad.storage volumes')
  const running = (await link.sh('cat /tmp/x1d/VERSION 2>/dev/null')).output.trim()
  return {
    firmware: version,
    supported: version === SUPPORTED_FIRMWARE,
    hasKey: Number(hasKey) >= 32,
    bootScriptCurrent: sumOf(`${HOME}/boot.sh`) === (await sha256Hex(firmware.bootScript)),
    serviceCurrent:
      sumOf(UNIT_PATH) === (await sha256Hex(firmware.unit)) && has(WANTS_PATH) && !has(OLD_WANTS_PATH),
    cards: [...new Set(volumes.output.match(/\/SD[0-9]+/g) ?? [])],
    installed: [UNIT_PATH, WANTS_PATH, OLD_WANTS_PATH, HOME].some(has),
    running: running || null,
  }
}

/** The VERSION file in the card setup, e.g. "Hazel 9bfeea7 built 2026-10-31". */
export function archiveVersion(archive: Uint8Array): string | null {
  const text = new TextDecoder()
  for (let at = 0; at + 512 <= archive.length; ) {
    const header = archive.subarray(at, at + 512)
    if (header.every((b) => b === 0)) break
    const field = (from: number, length: number) => text.decode(header.subarray(from, from + length)).replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const name = field(345, 155) ? `${field(345, 155)}/${field(0, 100)}` : field(0, 100)
    if (name === 'VERSION' || name === './VERSION') return text.decode(archive.subarray(at + 512, at + 512 + size)).trim()
    at += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

/** What Catkin's boot.sh checks: SHA-256 of the key, the archive's SHA-256 and the key again, a
 *  line each. */
export async function seal(key: string, archive: Uint8Array<ArrayBuffer>): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`${key}\n${await sha256Hex(archive)}\n${key}\n`))
}

export interface InstallOptions {
  /** the person agreed to the one permanent change: the start-up service on the system partition */
  allowServiceInstall: boolean
  onStep?: (step: string) => void
}

export class NeedsPermission extends Error {}

export async function install(link: CameraLink, firmware: Firmware, options: InstallOptions): Promise<CameraState> {
  const step = options.onStep ?? (() => {})
  step('Checking the camera')
  const state = await inspect(link, firmware)
  if (!state.supported) throw new Error(`this camera has firmware ${state.firmware}; Hazel needs 1.25.0`)
  if (state.cards.length === 0) throw new Error('there is no memory card in the camera')
  if (!state.serviceCurrent && !options.allowServiceInstall) {
    throw new NeedsPermission('starting Hazel with the camera needs a change to its system partition')
  }

  let key = (await link.sh(`cat ${HOME}/key 2>/dev/null`)).output.replace(/\n+$/, '')
  if (key.length < 32) {
    step('Making this camera’s key')
    key = randomKey()
    await link.push(new TextEncoder().encode(key + '\n'), `${HOME}/key`, '600', firmware.helper)
  }
  if (!state.bootScriptCurrent) {
    step('Copying the start script')
    await link.push(firmware.bootScript, `${HOME}/boot.sh`, '755', firmware.helper)
  }
  if (!state.serviceCurrent) {
    step('Setting the camera to start Hazel')
    await link.push(firmware.unit, `/tmp/${UNIT}`, '644', firmware.helper)
    await link.sh(
      `mount -o remount,rw / && cp /tmp/${UNIT} ${UNIT_PATH} && ln -sf ../${UNIT} ${WANTS_PATH} && rm -f ${OLD_WANTS_PATH} && sync; ` +
        `mount -o remount,ro /; systemctl daemon-reload; rm -f /tmp/${UNIT}`,
    )
  }

  const card = state.cards[0]
  const signature = new TextEncoder().encode((await seal(key, firmware.archive)) + '\n')
  for (const [name, data, label] of [
    [TAR, firmware.archive, 'Copying Hazel to the memory card'],
    [SIG, signature, 'Sealing it with the camera’s key'],
  ] as const) {
    step(label)
    await writeToCard(link, card, name, data, firmware.helper)
  }

  step('Checking everything')
  const after = await inspect(link, firmware)
  if (!after.hasKey || !after.bootScriptCurrent || !after.serviceCurrent) {
    throw new Error('the camera doesn’t show the install afterwards')
  }
  return after
}

/** Through the camera's storage service, as Catkin's `card --usb` does: the service never
 *  shortens a file it overwrites, so the old one goes first, and it only reads a card with live
 *  view off. Read back to check. */
async function writeToCard(
  link: CameraLink,
  card: string,
  name: string,
  data: Uint8Array<ArrayBuffer>,
  helper: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const staging = `/tmp/${name}`
  await link.push(data, staging, '644', helper)
  const out = await link.sh(
    `busctl --system call com.hasselblad.video / com.hasselblad.video setLiveviewState bbs false false ""; sleep 2; ` +
      `${STORAGE} Remove s ${card}/${name} >/dev/null 2>&1; ` +
      `${STORAGE} WriteFile sis ${staging} ${data.length} ${card}/${name} >/dev/null && ` +
      `${STORAGE} File stis ${card}/${name} 0 ${data.length} /tmp/back >/dev/null; sha256sum /tmp/back; rm -f /tmp/back ${staging}`,
    120000,
  )
  if (!out.output.includes(await sha256Hex(data))) throw new Error(`the copy of ${name} on the card doesn’t match`)
}

/** What `catkin remove` does, and Hazel's pair off the memory card too: the service and its links
 *  off the system partition, the key and start script off the data partition. Recipes and photos on
 *  the card stay. Hazel keeps running until the camera is turned off. */
export async function remove(link: CameraLink, onStep: (step: string) => void = () => {}): Promise<void> {
  onStep('Removing the start-up service')
  await link.sh(
    `if [ -e ${UNIT_PATH} ] || [ -L ${WANTS_PATH} ] || [ -L ${OLD_WANTS_PATH} ]; then mount -o remount,rw / && ` +
      `rm -f ${WANTS_PATH} ${OLD_WANTS_PATH} ${UNIT_PATH} && sync; mount -o remount,ro /; systemctl daemon-reload; fi`,
  )
  onStep('Removing the key and start script')
  await link.run(`rm -rf ${HOME}`)
  const volumes = await link.sh('busctl --system get-property com.hasselblad.storage / com.hasselblad.storage volumes')
  const cards = [...new Set(volumes.output.match(/\/SD[0-9]+/g) ?? [])]
  if (cards.length > 0) {
    onStep('Removing Hazel from the memory card')
    for (const card of cards) {
      await link.sh(
        `busctl --system call com.hasselblad.video / com.hasselblad.video setLiveviewState bbs false false ""; sleep 2; ` +
          `${STORAGE} Remove s ${card}/${TAR} >/dev/null 2>&1; ${STORAGE} Remove s ${card}/${SIG} >/dev/null 2>&1; true`,
        120000,
      )
    }
  }
  onStep('Checking everything')
  const left = await link.run(`ls -d ${UNIT_PATH} ${WANTS_PATH} ${OLD_WANTS_PATH} ${HOME} 2>/dev/null; true`)
  if (left.trim() !== '') throw new Error(`these are still on the camera: ${left.trim().split('\n').join(', ')}`)
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
