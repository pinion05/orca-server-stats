// Running the Orca CLI as a child process, which is how the remote mode reaches a workspace on a
// paired server: the plugin host API has no way to choose the server, and the CLI has. Each call
// is one `orca <args> --json` and answers with what the CLI printed, or with why it could not.

import { execFile, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** What one call came to: the CLI's answer, or a code and a sentence. */
export type CliOutcome = { ok: true; result: unknown } | { ok: false; code: string; message: string }

/** A call that did not come to an answer. */
export type CliFailure = Extract<CliOutcome, { ok: false }>

export type CliExecOptions = {
  timeoutMs: number
  env: Record<string, string | undefined>
}

/** How one command ended. `killed` is a timeout; `code` an exit status or a spawn error's code. */
export type CliExecResult = {
  killed: boolean
  code: number | string | null | undefined
  stdout: string
  stderr: string
}

/** Runs one command and always answers, also when it could not start. */
export type CliExec = (file: string, args: readonly string[], options: CliExecOptions) => Promise<CliExecResult>

export type OrcaCli = {
  (args: readonly string[], options?: { timeoutMs?: number }): Promise<CliOutcome>
  /** Ends the calls in flight; a call after it fails at once. */
  stop(): void
}

export const DEFAULT_CLI_TIMEOUT_MS = 8_000
/** The CLI's answer is small; anything this large is not one. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** Where Orca puts its `orca` command for one user, tried when the PATH has none. */
const USER_CLI = ['.config', 'orca', 'cli', 'bin']

/**
 * The environment the CLI runs with: the worker's own, and the server to reach when one is set.
 * The CLI takes a server or a pairing code, never both, so the three variables that choose its
 * target are the plugin's alone to set: with no server set, the computer's own Orca is reached,
 * whatever the worker was started with.
 */
export function cliEnvironment(
  base: Record<string, string | undefined>,
  environment: string
): Record<string, string | undefined> {
  const env = { ...base }
  const target = environment.trim()
  delete env.ORCA_PAIRING_CODE
  delete env.ORCA_REMOTE_PAIRING
  if (target !== '') {
    env.ORCA_ENVIRONMENT = target
  } else {
    delete env.ORCA_ENVIRONMENT
  }
  return env
}

type Envelope = { ok: boolean; result?: unknown; error?: { code?: unknown; message?: unknown } }

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'ok' in value
}

/** The JSON object the CLI answers with, in a text that is all of it; else null. */
function envelopeIn(text: string): Envelope | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isEnvelope(parsed) ? parsed : null
  } catch {
    // Not JSON: something else answered.
    return null
  }
}

/**
 * The CLI's answer. It prints one JSON object, `ok` with a result or an error's code and message,
 * alone or after whatever else it said first; anything else is not the Orca CLI, and the first
 * line of it is passed on as the reason.
 */
export function parseCliOutput(stdout: string, stderr: string): CliOutcome {
  const text = stdout.trim()
  if (text !== '') {
    const lines = text.split('\n')
    const from = lines.findIndex((line) => line.startsWith('{'))
    const parsed = envelopeIn(text) ?? (from > 0 ? envelopeIn(lines.slice(from).join('\n')) : null)
    if (parsed) {
      return parsed.ok === true
        ? { ok: true, result: parsed.result }
        : {
            ok: false,
            code: String(parsed.error?.code ?? 'error'),
            message: String(parsed.error?.message ?? 'the Orca CLI failed')
          }
    }
  }
  const first = (text || stderr).trim().split('\n')[0]?.slice(0, 160) ?? ''
  return {
    ok: false,
    code: 'not_orca_cli',
    message: first === '' ? 'the orca command printed nothing' : `the orca command did not answer JSON: ${first}`
  }
}

/** A failed call in a few words, for the tooltip and the log. */
export function describeCliFailure(failure: { code: string; message: string }): string {
  switch (failure.code) {
    case 'terminal_handle_stale':
    case 'terminal_not_found':
      return 'the stats terminal is gone'
    case 'selector_not_found':
      return 'no workspace has this selector'
    case 'ENOENT':
      return 'Orca CLI not found (see the Orca CLI setting)'
    case 'timeout':
      return 'the Orca CLI did not answer in time'
    default:
      return failure.message.trim() || failure.code
  }
}

/** `~` at the start names the home folder, which a setting may use. */
export function expandHome(command: string, home: string): string {
  const trimmed = command.trim()
  return trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether a file starts like a Python script, read from its first bytes. */
function isPythonScript(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const bytes = new Uint8Array(64)
    const head = new TextDecoder().decode(bytes.subarray(0, readSync(fd, bytes, 0, 64, 0)))
    return /^#!.*python/i.test(head)
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * Where the `orca` setting points. A path is taken as it is. A bare name is looked up on the PATH,
 * skipping an `orca` that is a Python script: on a Linux desktop that is the GNOME screen reader,
 * not this Orca. When the PATH has none, Orca's own command for this user is tried.
 */
export function resolveCliCommand(command: string, context: { home: string; path?: string }): string {
  const name = expandHome(command, context.home)
  if (name === '' || isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return name
  }
  for (const dir of (context.path ?? '').split(delimiter)) {
    if (dir === '') {
      continue
    }
    const candidate = join(dir, name)
    if (isFile(candidate) && !isPythonScript(candidate)) {
      return candidate
    }
  }
  const own = join(context.home, ...USER_CLI, name)
  return isFile(own) ? own : name
}

/** `execFile` behind `CliExec`: it answers also when the command cannot start. */
function execFileCli(children: Set<ChildProcess>): CliExec {
  return (file, args, options) =>
    new Promise((resolve) => {
      try {
        const child = execFile(
          file,
          args,
          {
            timeout: options.timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            env: options.env,
            killSignal: 'SIGTERM'
          },
          (error, stdout, stderr) => {
            children.delete(child)
            resolve({ killed: error?.killed === true, code: error?.code, stdout, stderr })
          }
        )
        children.add(child)
      } catch (error) {
        resolve({ killed: false, code: 'spawn_failed', stdout: '', stderr: String(error) })
      }
    })
}

/**
 * The CLI as the remote mode calls it. `command` is the setting: the `orca` on the PATH by default.
 * `environment` is the paired server to reach, empty for the computer's own Orca.
 */
export function createOrcaCli(options: {
  command: string
  environment: string
  env?: Record<string, string | undefined>
  exec?: CliExec
  home?: string
  path?: string
}): OrcaCli {
  const home = options.home ?? homedir()
  const command = resolveCliCommand(options.command, { home, path: options.path ?? process.env.PATH })
  const env = cliEnvironment(options.env ?? process.env, options.environment)
  const children = new Set<ChildProcess>()
  const exec = options.exec ?? execFileCli(children)
  let stopped = false

  const cli = async (args: readonly string[], callOptions?: { timeoutMs?: number }): Promise<CliOutcome> => {
    if (stopped) {
      return { ok: false, code: 'stopped', message: 'the plugin is stopping' }
    }
    const timeoutMs = callOptions?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
    const result = await exec(command, [...args, '--json'], { timeoutMs, env })
    if (result.killed) {
      return {
        ok: false,
        code: 'timeout',
        message: `no answer from the Orca CLI in ${Math.round(timeoutMs / 1000)} s`
      }
    }
    if (result.code === 'ENOENT') {
      return { ok: false, code: 'ENOENT', message: `the Orca CLI was not found: ${command}` }
    }
    if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { ok: false, code: 'too_long', message: 'the Orca CLI printed more than could be read' }
    }
    return parseCliOutput(result.stdout, result.stderr)
  }

  cli.stop = (): void => {
    stopped = true
    for (const child of children) {
      child.kill()
    }
    children.clear()
  }
  return cli
}
