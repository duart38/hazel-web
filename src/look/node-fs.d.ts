// The two Node functions the look engine's tests use. The web project has no @types/node (and
// takes no new dependencies), and the tests run in Node through vitest.
declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array<ArrayBuffer>
  export function existsSync(path: string | URL): boolean
}
