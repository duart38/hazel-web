// A helper thread of the look worker (threads.ts): it gets its start once, then runs look.c's
// bands for good, until the look worker terminates it.

import { runHelper, type HelperStart } from './threads'

interface HelperScope {
  postMessage(message: 'ready'): void
  onmessage: ((event: MessageEvent<HelperStart>) => void) | null
}
const scope = self as unknown as HelperScope

scope.onmessage = (event) => {
  scope.onmessage = null
  runHelper(event.data, () => scope.postMessage('ready'))
}
