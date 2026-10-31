// The camera's service channel over USB, as Catkin's Python tools speak it (Hazel-firmware's
// usb/x1d_usb_pull_file.py and usb/x1d_usb_shell.py): vendor 0x2756, product 0x0002, interface 0,
// bulk endpoints 2 out and 2 in. Every message is a 5-byte header and a 252-byte payload; the
// payload starts with five little-endian words (command, status, unused, checksum, result) and
// carries up to 232 bytes of data from offset 0x14.

export const VENDOR_ID = 0x2756
export const PRODUCT_ID = 0x0002
export const ENDPOINT = 2
export const PAYLOAD_LENGTH = 252
export const DATA_OFFSET = 0x14
/** a shell command, or a piece of input, fits in one payload: 232 bytes less its terminating 0 */
export const MAX_COMMAND = 231
/** HblShell: runs a line in /bin/sh as root and streams its output back */
export const CMD_HBL_SHELL = 65
/** a reply frame over USB 3: padded to this, several possibly in one transfer */
export const FRAME_STRIDE = 1024

export function crc16(data: Uint8Array): number {
  let crc = 0
  for (const b of data) {
    let x = (b ^ (crc >> 8)) & 0xff
    x = (x ^ (x >> 4)) & 0xffff
    crc = ((x | ((crc << 8) & 0xffff)) ^ ((x << 12) & 0xffff) ^ ((x << 5) & 0xffff)) & 0xffff
  }
  return crc
}

/** An HblShell request: request 0 starts `data` as a command, request 1 sends it as input to the
 *  command already running. */
export function shellRequest(data: Uint8Array, request: 0 | 1 = 0): Uint8Array<ArrayBuffer> {
  if (data.length > MAX_COMMAND) throw new RangeError(`${data.length} bytes is more than one request holds`)
  const frame = new Uint8Array(5 + PAYLOAD_LENGTH)
  frame.set([0x0a, 0x00, 0x08, 0x05, 0xfc])
  const payload = frame.subarray(5)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  view.setUint32(0x00, CMD_HBL_SHELL, true)
  view.setUint32(0x04, request, true)
  payload.set(data, DATA_OFFSET)
  view.setUint32(0x0c, crc16(payload.subarray(DATA_OFFSET, DATA_OFFSET + 232)), true)
  return frame
}

export interface Reply {
  command: number
  status: number
  result: number
  /** the data, up to its first 0 byte */
  data: Uint8Array
}

/** One reply frame from the camera, or null for anything that isn't one (padding, other traffic). */
export function parseReply(frame: Uint8Array): Reply | null {
  if (frame.length < 5 + DATA_OFFSET) return null
  const signal = frame[0] | (frame[1] << 8)
  if (signal !== 0x0009 || frame[2] !== 5 || frame[3] !== 8 || frame[4] !== PAYLOAD_LENGTH) return null
  const payload = frame.subarray(5, 5 + PAYLOAD_LENGTH)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const raw = payload.subarray(DATA_OFFSET)
  const end = raw.indexOf(0)
  return {
    command: view.getUint32(0x00, true),
    status: view.getUint32(0x04, true),
    result: view.getUint32(0x10, true),
    data: end < 0 ? raw : raw.subarray(0, end),
  }
}

/** A transfer from the camera, cut into its frames (over USB 3 they come padded to 1024 bytes,
 *  and several can arrive in one transfer). */
export function splitFrames(transfer: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = []
  for (let at = 0; at < transfer.length; at += FRAME_STRIDE) frames.push(transfer.subarray(at, at + FRAME_STRIDE))
  return frames
}
