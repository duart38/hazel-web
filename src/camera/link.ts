// A connection to the camera's service channel through WebUSB: shell commands as root, and files
// sent to it. The same steps as Catkin's Camera class (Hazel-firmware's catkin), so the camera sees
// exactly what it sees from the Mac. Works with the browser's navigator.usb and with the `usb`
// package's WebUSB in Node (the live tests).

import { CMD_HBL_SHELL, ENDPOINT, FRAME_STRIDE, MAX_COMMAND, parseReply, shellRequest, splitFrames, type Reply } from './protocol'

export class CameraTimeout extends Error {}

const text = new TextEncoder()
const decoder = new TextDecoder()

/** where the upload helper (Hazel-firmware's camera/unb64) lives on the camera until it restarts */
export const DECODER = '/tmp/catkin-unb64'

export interface ShellResult {
  result: number
  output: string
}

export class CameraLink {
  private replies: Reply[] = []
  private waiting: (() => void) | null = null
  private reading = false
  private failure: unknown = null

  readonly device: USBDevice

  private constructor(device: USBDevice) {
    this.device = device
  }

  static async open(device: USBDevice): Promise<CameraLink> {
    if (!device.opened) await device.open()
    if (device.configuration?.configurationValue !== 1) await device.selectConfiguration(1)
    await device.claimInterface(0)
    const link = new CameraLink(device)
    link.startReading()
    return link
  }

  async close(): Promise<void> {
    this.reading = false
    try {
      await this.device.close()
    } catch {
      // already gone (unplugged, switched off)
    }
  }

  /** One transfer always waiting on the camera: WebUSB reads have no timeout of their own, so
   *  replies go into a queue that callers wait on with one. */
  private startReading(): void {
    this.reading = true
    const loop = async () => {
      while (this.reading) {
        try {
          // One frame a read: frames are exactly the endpoint's packet size, so the camera never
          // sends the short packet that would end a longer read, and WebUSB reads can't time out.
          const got = await this.device.transferIn(ENDPOINT, FRAME_STRIDE)
          if (got.data && got.data.byteLength > 0) {
            const bytes = new Uint8Array(got.data.buffer, got.data.byteOffset, got.data.byteLength)
            for (const frame of splitFrames(bytes)) {
              const reply = parseReply(frame)
              if (reply) this.replies.push({ ...reply, data: reply.data.slice() })
            }
          }
        } catch (error) {
          if (this.reading) this.failure = error
          this.reading = false
        }
        this.wake()
      }
    }
    void loop()
  }

  private wake(): void {
    const w = this.waiting
    this.waiting = null
    w?.()
  }

  private async next(timeoutMs: number): Promise<Reply> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const reply = this.replies.shift()
      if (reply) return reply
      if (this.failure) throw this.failure
      if (!this.reading) throw new Error('the camera connection is closed')
      const left = deadline - Date.now()
      if (left <= 0) throw new CameraTimeout('the camera did not answer in time')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiting = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }

  /** what's left of earlier replies, so the next command reads only its own */
  private async drain(): Promise<void> {
    await sleep(80)
    this.replies = []
  }

  private async send(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const result = await this.device.transferOut(ENDPOINT, frame)
    if (result.status !== 'ok') throw new Error(`sending to the camera failed (${result.status})`)
  }

  /** Runs a command in the camera's shell as root. A command over 231 bytes goes up as a script
   *  first, as catkin does. `timeoutMs` is how long it may go quiet, not how long it may take. */
  async sh(command: string, timeoutMs = 30000): Promise<ShellResult> {
    let bytes = text.encode(command)
    if (bytes.length > MAX_COMMAND) {
      await this.push(text.encode(command + '\n'), '/tmp/x1dcl.sh')
      bytes = text.encode('sh /tmp/x1dcl.sh')
    }
    await this.drain()
    await this.send(shellRequest(bytes))
    const chunks: Uint8Array[] = []
    const output = () => decoder.decode(concat(chunks))
    let lastStatus = 0
    for (;;) {
      const reply = await this.next(timeoutMs)
      if (reply.command !== CMD_HBL_SHELL) continue
      lastStatus = reply.status
      if (reply.status === 4) {
        chunks.push(reply.data)
        continue
      }
      if (reply.status === 0 && reply.data.length === 0) return { result: reply.result, output: output() }
      if (reply.data.length > 0) {
        chunks.push(reply.data)
        continue
      }
      return { result: reply.result || lastStatus, output: output() }
    }
  }

  /** sh, failing unless the command succeeds */
  async run(command: string, timeoutMs?: number): Promise<string> {
    const { result, output } = await this.sh(command, timeoutMs)
    if (result !== 0) throw new Error(`camera command failed (${result}): ${command.slice(0, 80)}\n${output}`)
    return output
  }

  async sha256Of(remote: string): Promise<string> {
    const out = await this.sh(`sha256sum ${remote} 2>/dev/null`)
    return out.output.trim().split(/\s+/)[0] ?? ''
  }

  /** Uploads bytes to a file on the camera, gzipped, and checks they arrived intact: next to the
   *  target first, then renamed into place. Fast through the upload helper when `helper` (the
   *  bytes of camera/unb64) is given, else one command per chunk (about 50 bytes a second). */
  async push(data: Uint8Array<ArrayBuffer>, remote: string, mode = '644', helper?: Uint8Array<ArrayBuffer>): Promise<void> {
    const packed = await gzip(data)
    const staging = `${remote}.upload.gz`
    await this.run(`mkdir -p ${remote.slice(0, remote.lastIndexOf('/')) || '/'}`)
    let sent = false
    if (packed.length > 2000 && helper && (await this.ensureHelper(helper))) {
      const want = await sha256Hex(packed)
      for (const gapMs of [10, 30, 100]) {
        try {
          await this.sendFast(packed, staging, gapMs)
        } catch {
          continue
        }
        if ((await this.sha256Of(staging)) === want) {
          sent = true
          break
        }
      }
    }
    if (!sent) await this.sendSlow(packed, staging)
    // kept apart so each stays under the command limit
    await this.run(`gunzip -c ${staging} >${remote}.new`)
    await this.run(`rm -f ${staging}; chmod ${mode} ${remote}.new`)
    await this.run(`mv -f ${remote}.new ${remote}`)
    if ((await this.sha256Of(remote)) !== (await sha256Hex(data))) throw new Error(`${remote} arrived damaged`)
  }

  /** bytes as printf octal escapes, one command a chunk: needs nothing on the camera */
  private async sendSlow(packed: Uint8Array, staging: string): Promise<void> {
    const literal = new Set(text.encode('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,._-+=:/@'))
    await this.run(`rm -f ${staging}`)
    const prefix = "printf '"
    const suffix = `'>>${staging}`
    const budget = MAX_COMMAND - prefix.length - suffix.length
    let sent = 0
    while (sent < packed.length) {
      let piece = ''
      let take = 0
      while (sent + take < packed.length) {
        const b = packed[sent + take]
        const next = literal.has(b) ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0')
        if (piece.length + next.length > budget) break
        piece += next
        take++
      }
      await this.run(prefix + piece + suffix)
      sent += take
    }
  }

  private async ensureHelper(helper: Uint8Array<ArrayBuffer>): Promise<boolean> {
    if ((await this.sha256Of(DECODER)) === (await sha256Hex(helper))) return true
    await this.sendSlow(await gzip(helper), `${DECODER}.gz`)
    await this.run(`gunzip -c ${DECODER}.gz >${DECODER} && rm -f ${DECODER}.gz && chmod 755 ${DECODER}`)
    return (await this.sha256Of(DECODER)) === (await sha256Hex(helper))
  }

  private async readUntil(marker: string, timeoutMs: number): Promise<string> {
    let output = ''
    const deadline = Date.now() + timeoutMs
    while (!output.includes(marker) && Date.now() < deadline) {
      try {
        const reply = await this.next(Math.min(200, Math.max(1, deadline - Date.now())))
        if (reply.command === CMD_HBL_SHELL) output += decoder.decode(reply.data)
      } catch (error) {
        if (!(error instanceof CameraTimeout)) throw error
      }
    }
    return output
  }

  /** Base64 into the upload helper, about 10 KB a second. Requests sent back to back get dropped,
   *  hence the gap; the caller compares checksums and tries again slower. */
  private async sendFast(packed: Uint8Array, staging: string, gapMs: number): Promise<void> {
    const encoded = text.encode(base64(packed) + '.')
    await this.drain()
    await this.send(shellRequest(text.encode(`exec ${DECODER} ${staging}\n`)))
    if (!(await this.readUntil('READY', 10000)).includes('READY')) throw new Error("the upload helper didn't start")
    for (let i = 0; i < encoded.length; i += MAX_COMMAND) {
      await this.send(shellRequest(encoded.subarray(i, i + MAX_COMMAND), 1))
      await sleep(gapMs)
    }
    const reply = await this.readUntil('OK', 30000)
    await this.drain()
    if (!reply.includes('OK')) throw new Error(`the upload helper didn't finish: ${reply}`)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function concat(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.length
  }
  return all
}

function base64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(binary)
}
