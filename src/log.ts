/** Passes a message on, and then not again until a different one comes or `reset` is called. */
export type LogOnce = ((message: string) => void) & { reset(): void }

/** For a message that would otherwise repeat on every reading. A log call that throws is dropped. */
export function logOnce(sink: (message: string) => void): LogOnce {
  let last: string | null = null
  const log = (message: string): void => {
    if (message === last) {
      return
    }
    last = message
    try {
      sink(message)
    } catch {
      // A log line must never stop the caller.
    }
  }
  log.reset = (): void => {
    last = null
  }
  return log
}

/** What an error says, in a few words. */
export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { message, code } = error as { message?: string; code?: string }
    return message || code || String(error)
  }
  return String(error)
}
