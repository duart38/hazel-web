// How a photo was taken, as text for the shooting info bar: the photographer's order, exposure
// first, then lens, mode and date.

import type { ShootingInfo } from '../engine/types'

/** 9 → "9", 3.5 → "3.5" */
export function trimmed(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return rounded === Math.round(rounded) ? String(Math.round(rounded)) : String(rounded)
}

export function shutterText(seconds: number): string {
  if (!(seconds > 0)) return '0 s'
  if (seconds >= 0.3) return `${trimmed(Math.round(seconds * 10) / 10)} s`
  return `1/${Math.round(1 / seconds)} s`
}

/** in thirds, as cameras set it: +1/3, −1 2/3; nothing when it's 0 */
export function stopsText(value: number): string | undefined {
  const thirds = Math.round(value * 3)
  if (thirds === 0) return undefined
  const sign = thirds > 0 ? '+' : '−'
  const whole = Math.floor(Math.abs(thirds) / 3)
  const rest = Math.abs(thirds) % 3
  const text = rest === 0 ? `${whole}` : whole === 0 ? `${rest}/3` : `${whole} ${rest}/3`
  return `${sign}${text} EV`
}

/** Shutter, aperture, ISO, compensation, focal length, lens, mode; missing ones left out. The first
 *  three (when all there) are the exposure. */
export function infoParts(info: ShootingInfo): string[] {
  const parts: (string | undefined)[] = [
    info.shutterSeconds === undefined ? undefined : shutterText(info.shutterSeconds),
    info.aperture === undefined ? undefined : `f/${trimmed(info.aperture)}`,
    info.iso === undefined ? undefined : `ISO ${info.iso}`,
    info.exposureCompensation === undefined ? undefined : stopsText(info.exposureCompensation),
    info.focalLength === undefined ? undefined : `${trimmed(info.focalLength)} mm`,
    info.lens,
    info.mode,
  ]
  return parts.filter((p): p is string => p !== undefined && p !== '')
}

export function takenText(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/** The info line's tooltip: what it shows, as far as this photo has it. */
export function infoHelp(info: ShootingInfo): string {
  const lines = ['As the camera recorded it: shutter speed, aperture, ISO']
  if (info.exposureCompensation !== undefined && stopsText(info.exposureCompensation) !== undefined) lines.push('exposure compensation')
  if (info.focalLength35mm !== undefined && info.focalLength !== undefined) {
    lines.push(`${trimmed(info.focalLength)} mm is like ${info.focalLength35mm} mm on a 35 mm camera`)
  }
  if (info.taken) lines.push("the date is by the camera's own clock")
  return lines.join(', ')
}
