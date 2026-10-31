// The USB framing against Catkin's Python tools (the hashes are of frames its
// make_hbl_shell_request builds), and the connection against a pretend camera that runs the
// handful of shell commands an upload uses.
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { archiveVersion, seal } from './installer'
import { CameraLink, sha256Hex } from './link'
import { CMD_HBL_SHELL, crc16, DATA_OFFSET, FRAME_STRIDE, PAYLOAD_LENGTH, parseReply, shellRequest, splitFrames } from './protocol'

const text = new TextEncoder()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('framing', () => {
  it('checksums like the camera', () => {
    expect(crc16(new Uint8Array())).toBe(0)
    expect(crc16(text.encode('123456789'))).toBe(0x31c3)
    expect(crc16(Uint8Array.from({ length: 256 }, (_, i) => i))).toBe(0x7e55)
  })

  it('builds the same requests as the Python tools', () => {
    expect(sha(shellRequest(text.encode('echo hi')))).toBe('9d0070782632ac14bdbbdd5d9236a34de308ec569744fb91887ea19365cd65b1')
    expect(sha(shellRequest(text.encode('cat /etc/version')))).toBe('f47f23de679b93a21dc1263601e6d361996a9d7ef3025c83b8449237f788773f')
    expect(sha(shellRequest(text.encode('QUJD'), 1))).toBe('9e8a4a7240677f913b584f5c007de6432ff0719aa681662d976b3314ce35448a')
  })

  it('seals like catkin', async () => {
    const archive = Uint8Array.from({ length: 200 }, (_, i) => i)
    expect(await seal('0123456789abcdef'.repeat(4), archive)).toBe('5578723a4e44cd284db412b2bd065c3a7da401309cc45c611f2bd8a05099f65b')
  })

  it('reads the version inside a card setup', () => {
    const file = (name: string, body: string) => {
      const header = new Uint8Array(512)
      header.set(text.encode(name))
      header.set(text.encode(body.length.toString(8).padStart(11, '0')), 124)
      const data = new Uint8Array(Math.ceil(body.length / 512) * 512)
      data.set(text.encode(body))
      return [header, data]
    }
    const parts = [...file('load.sh', '#!/bin/sh\n'.repeat(80)), ...file('VERSION', 'Hazel 9bfeea7 built 2026-10-31\n'), new Uint8Array(1024)]
    expect(archiveVersion(Buffer.concat(parts))).toBe('Hazel 9bfeea7 built 2026-10-31')
    expect(archiveVersion(new Uint8Array(1024))).toBeNull()
  })

  it('refuses a command that does not fit', () => {
    expect(() => shellRequest(new Uint8Array(232))).toThrow(RangeError)
  })

  it('reads replies and skips padding', () => {
    const transfer = new Uint8Array(FRAME_STRIDE * 2)
    transfer.set(reply(4, 0, 'hello'), 0)
    transfer.set(reply(0, 3, ''), FRAME_STRIDE)
    const replies = splitFrames(transfer).map(parseReply)
    expect(replies.map((r) => r && [r.status, r.result, new TextDecoder().decode(r.data)])).toEqual([
      [4, 0, 'hello'],
      [0, 3, ''],
    ])
    expect(parseReply(new Uint8Array(FRAME_STRIDE))).toBeNull()
  })
})

/** a reply frame as the camera sends it */
function reply(status: number, result: number, data: string | Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + PAYLOAD_LENGTH)
  frame.set([0x09, 0x00, 5, 8, PAYLOAD_LENGTH])
  const view = new DataView(frame.buffer, 5)
  view.setUint32(0, CMD_HBL_SHELL, true)
  view.setUint32(4, status, true)
  view.setUint32(0x10, result, true)
  frame.set(typeof data === 'string' ? text.encode(data) : data, 5 + DATA_OFFSET)
  return frame
}

/** Just enough of the camera's shell for an upload: printf >>, rm -f, mkdir -p, gunzip -c a >b,
 *  chmod, mv -f, sha256sum, echo, cat, and `;` between them. Long output comes back in 200-byte
 *  pieces, several to a transfer, like the real thing over USB 3. */
class PretendCamera {
  files = new Map<string, Uint8Array>()
  commands: string[] = []
  private pending: Uint8Array[] = []
  private wakeReader: (() => void) | null = null
  opened = false
  configuration: { configurationValue: number } | null = null

  asDevice(): USBDevice {
    return this as unknown as USBDevice
  }

  async open() {
    this.opened = true
  }
  async close() {
    this.opened = false
    this.wakeReader?.()
  }
  async selectConfiguration(value: number) {
    this.configuration = { configurationValue: value }
  }
  async claimInterface() {}

  async transferOut(_endpoint: number, frame: Uint8Array): Promise<USBOutTransferResult> {
    const payload = frame.subarray(5)
    const raw = payload.subarray(DATA_OFFSET, DATA_OFFSET + 232)
    const end = raw.indexOf(0)
    const line = new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end))
    this.commands.push(line)
    const { output, result } = this.run(line)
    for (let i = 0; i < output.length; i += 199) this.queue(reply(4, 0, output.subarray(i, i + 199)))
    this.queue(reply(0, result, ''))
    return { bytesWritten: frame.length, status: 'ok' }
  }

  async transferIn(): Promise<USBInTransferResult> {
    while (this.pending.length === 0) {
      if (!this.opened) throw new Error('closed')
      await new Promise<void>((resolve) => (this.wakeReader = resolve))
    }
    const frames = this.pending.splice(0, 3)
    const transfer = new Uint8Array(FRAME_STRIDE * frames.length)
    frames.forEach((f, i) => transfer.set(f, i * FRAME_STRIDE))
    return { data: new DataView(transfer.buffer), status: 'ok' }
  }

  private queue(frame: Uint8Array) {
    this.pending.push(frame)
    const w = this.wakeReader
    this.wakeReader = null
    w?.()
  }

  private run(line: string): { output: Uint8Array; result: number } {
    const parts: Uint8Array[] = []
    let result = 0
    for (const part of line.split(/;\s*/)) {
      const one = this.one(part.trim())
      if (one === null) {
        result = 1
        break
      }
      parts.push(typeof one === 'string' ? text.encode(one) : one)
    }
    return { output: Buffer.concat(parts), result }
  }

  private one(command: string): string | Uint8Array | null {
    let m: RegExpMatchArray | null
    if ((m = command.match(/^printf '(.*)'>>(\S+)$/))) {
      const bytes = m[1].replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
      const more = Uint8Array.from(bytes, (c) => c.charCodeAt(0))
      const old = this.files.get(m[2]) ?? new Uint8Array()
      const both = new Uint8Array(old.length + more.length)
      both.set(old)
      both.set(more, old.length)
      this.files.set(m[2], both)
      return ''
    }
    if ((m = command.match(/^rm -f (\S+)$/))) return this.files.delete(m[1]), ''
    if (command.startsWith('mkdir -p ') || command.startsWith('chmod ')) return ''
    if ((m = command.match(/^gunzip -c (\S+) >(\S+)$/))) {
      const packed = this.files.get(m[1])
      if (!packed) return null
      this.files.set(m[2], new Uint8Array(gunzipSync(packed)))
      return ''
    }
    if ((m = command.match(/^mv -f (\S+) (\S+)$/))) {
      const data = this.files.get(m[1])
      if (!data) return null
      this.files.delete(m[1])
      this.files.set(m[2], data)
      return ''
    }
    if ((m = command.match(/^sha256sum (\S+) 2>\/dev\/null$/))) {
      const data = this.files.get(m[1])
      return data ? `${sha(data)}  ${m[1]}\n` : null
    }
    if ((m = command.match(/^echo (.*)$/))) return m[1] + '\n'
    if ((m = command.match(/^cat (\S+)$/))) {
      const data = this.files.get(m[1])
      return data ?? null
    }
    return null
  }
}

describe('connection', () => {
  it('runs a command and collects long output', async () => {
    const camera = new PretendCamera()
    const link = await CameraLink.open(camera.asDevice())
    const long = 'é'.repeat(900)
    camera.files.set('/etc/long', text.encode(long))
    expect(await link.sh('echo hi')).toEqual({ result: 0, output: 'hi\n' })
    expect((await link.sh('cat /etc/long')).output).toBe(long)
    expect((await link.sh('nonsense')).result).toBe(1)
    await expect(link.run('nonsense')).rejects.toThrow(/camera command failed/)
    await link.close()
  })

  it('uploads a file one command at a time and checks it', async () => {
    const camera = new PretendCamera()
    const link = await CameraLink.open(camera.asDevice())
    const data = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7919) % 251)
    await link.push(data, '/tmp/x1d/test.bin', '755')
    expect(sha(camera.files.get('/tmp/x1d/test.bin') ?? new Uint8Array())).toBe(await sha256Hex(data))
    expect([...camera.files.keys()]).toEqual(['/tmp/x1d/test.bin'])
    expect(camera.commands.every((c) => text.encode(c).length <= 231)).toBe(true)
    await link.close()
  })

  it('sends a long command as a script', async () => {
    const camera = new PretendCamera()
    const link = await CameraLink.open(camera.asDevice())
    const long = `echo ${'y'.repeat(300)}`
    await link.sh(long).catch(() => undefined)
    expect(new TextDecoder().decode(camera.files.get('/tmp/x1dcl.sh'))).toBe(long + '\n')
    expect(camera.commands.at(-1)).toBe('sh /tmp/x1dcl.sh')
    await link.close()
  })
})
