// The Orca CLI as a child process, which is how the remote mode reaches a paired server: how its
// answer is read, where the `orca` command is found, and what a call comes to when it fails.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { assert, test } from 'orca/testing'
import { emptySnapshot, formatTooltip } from './metrics'
import {
  cliEnvironment,
  createOrcaCli,
  DEFAULT_CLI_TIMEOUT_MS,
  describeCliFailure,
  expandHome,
  parseCliOutput,
  resolveCliCommand,
  type CliExec,
  type CliExecResult,
  type CliFailure
} from './orca-cli'

const ON_WINDOWS = process.platform === 'win32'

test('the answer the CLI prints: one JSON object, with a result or with an error', () => {
  const answer = (value: unknown): string => `${JSON.stringify(value)}\n`
  assert.deepEqual(parseCliOutput(answer({ ok: true, result: { terminals: [] } }), ''), {
    ok: true,
    result: { terminals: [] }
  })
  // What the CLI answered to a handle from another server, and to an unknown environment.
  assert.deepEqual(
    parseCliOutput(
      answer({ ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale', data: { nextSteps: ['...'] } } }),
      ''
    ),
    { ok: false, code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
  )
  assert.deepEqual(parseCliOutput(answer({ ok: false, error: { code: 'invalid_argument', message: 'Unknown environment: nope' } }), ''), {
    ok: false,
    code: 'invalid_argument',
    message: 'Unknown environment: nope'
  })
  // An error that says no more than its code, or nothing.
  assert.deepEqual(parseCliOutput(answer({ ok: false, error: { code: 'failed' } }), ''), {
    ok: false,
    code: 'failed',
    message: 'the Orca CLI failed'
  })
  assert.deepEqual(parseCliOutput(answer({ ok: false }), ''), { ok: false, code: 'error', message: 'the Orca CLI failed' })
  // A result may be anything, or nothing; and the answer may have room around it.
  assert.deepEqual(parseCliOutput(answer({ ok: true }), ''), { ok: true, result: undefined })
  assert.deepEqual(parseCliOutput(answer({ ok: true, result: null }), ''), { ok: true, result: null })
  assert.deepEqual(parseCliOutput('  {"ok":true,"result":1}\n\n', ''), { ok: true, result: 1 })
  // An answer that is not a clear yes is not one.
  assert.deepEqual(parseCliOutput('{"ok":"yes"}', ''), { ok: false, code: 'error', message: 'the Orca CLI failed' })
  // Said after a warning of its own, on a line of its own, it is still the answer.
  assert.deepEqual(parseCliOutput('Warning: this CLI is old\n{"ok":true,"result":1}\n', ''), { ok: true, result: 1 })
})

test('anything else on its output is not the Orca CLI, and the first line of it says what was', () => {
  const said = (message: string): CliFailure => ({ ok: false, code: 'not_orca_cli', message })
  /** What came of output that is not the CLI's, which must be a failure. */
  const failure = (stdout: string, stderr = ''): CliFailure => {
    const outcome = parseCliOutput(stdout, stderr)
    assert.equal(outcome.ok, false)
    return outcome as CliFailure
  }
  assert.deepEqual(failure('orca: command not found\n'), said('the orca command did not answer JSON: orca: command not found'))
  assert.deepEqual(failure('', 'Error: cannot open display\nmore\n'), said('the orca command did not answer JSON: Error: cannot open display'))
  assert.deepEqual(failure('  \n'), said('the orca command printed nothing'))
  // JSON, but not an answer of this shape.
  for (const text of ['[]', '"orca"', '42', '{}', '{"result":{}}', 'null']) {
    assert.deepEqual(failure(text), said(`the orca command did not answer JSON: ${text}`), text)
  }
  assert.equal(failure('first\nsecond').message, 'the orca command did not answer JSON: first')
  // The first line, and no more than 160 characters of it.
  assert.equal(failure('x'.repeat(300)).message.length, 'the orca command did not answer JSON: '.length + 160)
})

test('a failed call in a few words, whole in the tooltip', () => {
  const shown = (code: string, message = code): string =>
    formatTooltip(emptySnapshot([describeCliFailure({ code, message })]))
  assert.equal(shown('terminal_handle_stale'), 'unavailable: the stats terminal is gone')
  assert.equal(shown('terminal_not_found'), 'unavailable: the stats terminal is gone')
  assert.equal(shown('selector_not_found'), 'unavailable: no workspace has this selector')
  assert.equal(shown('ENOENT'), 'unavailable: Orca CLI not found (see the Orca CLI setting)')
  assert.equal(shown('timeout'), 'unavailable: the Orca CLI did not answer in time')
  // What the CLI itself said, where it said more than a code.
  assert.equal(shown('invalid_argument', 'Unknown environment: nope'), 'unavailable: Unknown environment: nope')
  assert.equal(shown('exited', 'the stats terminal exited'), 'unavailable: the stats terminal exited')
  assert.equal(shown('weird', ''), 'unavailable: weird')
  assert.equal(describeCliFailure({ code: 'a'.repeat(60), message: '' }), 'a'.repeat(60))
})

test('`~` in the Orca CLI setting names the home folder', () => {
  assert.equal(expandHome('~', '/home/me/'), '/home/me/')
  assert.equal(expandHome('~/bin/orca', '/home/me/'), join('/home/me/', 'bin/orca'))
  assert.equal(expandHome('  ~/.config/orca/cli/bin/orca ', '/home/me/'), join('/home/me/', '.config/orca/cli/bin/orca'))
  assert.equal(expandHome('orca', '/home/me/'), 'orca')
  assert.equal(expandHome('~other/bin/orca', '/home/me/'), '~other/bin/orca')
  assert.equal(expandHome('', '/home/me/'), '')
})

test('the environment a call runs with: the worker\'s own, and the server to reach when one is set', () => {
  // What the worker might have been started with: a server, or a pairing code to one.
  const base = { PATH: '/usr/bin', ORCA_ENVIRONMENT: 'laptop', ORCA_PAIRING_CODE: 'example-pairing-code', ORCA_REMOTE_PAIRING: '', HOME: '/home/me/' }
  // With no server set, the computer's own Orca is reached whatever the worker was started with.
  assert.deepEqual(cliEnvironment(base, ''), { PATH: '/usr/bin', HOME: '/home/me/' })
  // And the CLI takes a server or a pairing code, never both: the pairing code does not come along.
  assert.deepEqual(cliEnvironment(base, ' my-server '), { PATH: '/usr/bin', ORCA_ENVIRONMENT: 'my-server', HOME: '/home/me/' })
  assert.equal(base.ORCA_ENVIRONMENT, 'laptop')
  assert.equal(base.ORCA_PAIRING_CODE, 'example-pairing-code')
})

test('the `orca` to run: a path as it is, a bare name from the PATH, or Orca\'s own command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-stats-cli-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const other = join(root, 'other')
  const own = join(home, '.config', 'orca', 'cli', 'bin', 'orca')
  try {
    await mkdir(join(home, '.config', 'orca', 'cli', 'bin'), { recursive: true })
    await mkdir(bin, { recursive: true })
    await mkdir(other, { recursive: true })
    await writeFile(own, '#!/usr/bin/env node\n')
    const at = (path: string) => ({ home, path })
    // A path is taken as it is, and an empty setting stays empty.
    for (const command of ['/opt/orca/bin/orca', './orca', 'sub/orca', '']) {
      assert.equal(resolveCliCommand(command, at('')), command)
    }
    assert.equal(resolveCliCommand('~/.config/orca/cli/bin/orca', at('')), own)
    // Nothing on the PATH: Orca's own command for this user, where it is; elsewhere the name as it came.
    assert.equal(resolveCliCommand('orca', at('')), own)
    assert.equal(resolveCliCommand('orca', { home: join(root, 'nowhere'), path: '' }), 'orca')
    // An `orca` on the PATH that is a Python script is another program: on a Linux desktop, the screen reader.
    await writeFile(join(bin, 'orca'), '#!/usr/bin/python3 -s\nimport orca\n')
    assert.equal(resolveCliCommand('orca', at(`${bin}${delimiter}`)), own)
    assert.equal(resolveCliCommand('orca', at(bin)), own)
    // The first that is not one comes first, an empty entry being passed over.
    await writeFile(join(other, 'orca'), '#!/usr/bin/env node\n')
    assert.equal(resolveCliCommand('orca', at(`${other}:${bin}`)), join(other, 'orca'))
    assert.equal(resolveCliCommand('orca', at(`:${bin}:${other}`)), join(other, 'orca'))
    // An `orca` started with python3 -s is not it either; one started by env is.
    await writeFile(join(bin, 'orca'), '#!/usr/bin/env python3\n')
    assert.equal(resolveCliCommand('orca', at(`${bin}:${other}`)), join(other, 'orca'))
    await writeFile(join(bin, 'orca'), '#!/usr/bin/env node\n')
    assert.equal(resolveCliCommand('orca', at(`${bin}:${other}`)), join(bin, 'orca'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

type Call = { args: readonly string[]; timeoutMs: number; env: Record<string, string | undefined> }

/** The command the CLI runs, replaced by the test's: each call is noted, and answered as `answer` says. */
function scriptedExec(answer: (args: readonly string[]) => string | CliExecResult): { exec: CliExec; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    exec: async (file, args, options) => {
      calls.push({ args: [file, ...args], timeoutMs: options.timeoutMs, env: options.env })
      const reply = answer(args)
      return typeof reply === 'string' ? { killed: false, code: 0, stdout: reply, stderr: '' } : reply
    }
  }
}

test('each call is one `orca <args> --json`, with the server to reach in its environment', async () => {
  const { exec, calls } = scriptedExec(() => '{"ok":true,"result":{"terminal":{"handle":"term_1"}}}\n')
  const orca = createOrcaCli({
    command: '/opt/orca/bin/orca',
    environment: ' my-server ',
    env: { PATH: '/usr/bin', ORCA_ENVIRONMENT: 'laptop' },
    exec,
    path: ''
  })
  assert.deepEqual(await orca(['terminal', 'read', '--terminal', 'term_1']), {
    ok: true,
    result: { terminal: { handle: 'term_1' } }
  })
  assert.deepEqual(calls, [
    {
      args: ['/opt/orca/bin/orca', 'terminal', 'read', '--terminal', 'term_1', '--json'],
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      env: { PATH: '/usr/bin', ORCA_ENVIRONMENT: 'my-server' }
    }
  ])
  // Opening a terminal may take longer, and says so.
  await orca(['terminal', 'create'], { timeoutMs: 15_000 })
  assert.equal(calls[1]?.timeoutMs, 15_000)
  assert.equal(calls[1]?.args.at(-1), '--json')
})

test('a call that was killed is a timeout, and one that could not start names the command', async () => {
  const hung = scriptedExec(() => ({ killed: true, code: null, stdout: '', stderr: '' }))
  const orca = createOrcaCli({ command: 'orca', environment: '', exec: hung.exec, path: '' })
  assert.deepEqual(await orca(['terminal', 'list']), { ok: false, code: 'timeout', message: 'no answer from the Orca CLI in 8 s' })
  assert.deepEqual(await orca(['terminal', 'create'], { timeoutMs: 15_000 }), {
    ok: false,
    code: 'timeout',
    message: 'no answer from the Orca CLI in 15 s'
  })
  const missing = scriptedExec(() => ({ killed: false, code: 'ENOENT', stdout: '', stderr: '' }))
  const nowhere = createOrcaCli({ command: '/no/orca', environment: '', exec: missing.exec, path: '' })
  assert.deepEqual(await nowhere(['terminal', 'list']), { ok: false, code: 'ENOENT', message: 'the Orca CLI was not found: /no/orca' })
  // More output than can be read is said to be that, and not blamed on some other program answering.
  const flood = scriptedExec(() => ({ killed: false, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '{"ok":tr', stderr: '' }))
  assert.deepEqual(await createOrcaCli({ command: 'orca', environment: '', exec: flood.exec, path: '' })(['terminal', 'read']), {
    ok: false,
    code: 'too_long',
    message: 'the Orca CLI printed more than could be read'
  })
  // An exit status is not read: the CLI says what came of a call in what it prints.
  const refused = scriptedExec(() => ({
    killed: false,
    code: 1,
    stdout: '{"ok":false,"error":{"code":"selector_not_found","message":"selector_not_found"}}',
    stderr: ''
  }))
  const cli = createOrcaCli({ command: 'orca', environment: '', exec: refused.exec, path: '' })
  assert.deepEqual(await cli(['worktree', 'show']), { ok: false, code: 'selector_not_found', message: 'selector_not_found' })
})

test('after stop no call reaches the CLI', async () => {
  const { exec, calls } = scriptedExec(() => '{"ok":true}')
  const orca = createOrcaCli({ command: 'orca', environment: '', exec: exec, path: '' })
  orca.stop()
  assert.deepEqual(await orca(['terminal', 'list']), { ok: false, code: 'stopped', message: 'the plugin is stopping' })
  assert.equal(calls.length, 0)
})

/**
 * A stand-in for the Orca CLI: a script that notes how it was called, and then does what `then`
 * says. Only where there is a `/bin/sh`, since the real CLI is a process as it is.
 */
async function withStandIn(then: (dir: string) => string, run: (cli: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'server-stats-orca-'))
  const cli = join(dir, 'orca')
  try {
    await writeFile(
      cli,
      [
        '#!/bin/sh',
        `echo "$@" > '${dir}/args'`,
        `printf '%s' "\${ORCA_ENVIRONMENT:-}" > '${dir}/env'`,
        `printf '%s' "\${ORCA_PAIRING_CODE:-}\${ORCA_REMOTE_PAIRING:-}" > '${dir}/pairing'`,
        then(dir),
        ''
      ].join('\n')
    )
    await chmod(cli, 0o755)
    await run(cli, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Registers a test of the CLI as a real process; where there is no `/bin/sh` there is none. */
const posixTest = (name: string, fn: () => unknown): void => {
  if (!ON_WINDOWS) {
    test(name, fn)
  }
}

posixTest('the real command is run once per call, with --json and the server in its environment', async () => {
  await withStandIn(() => `printf '%s' '{"ok":true,"result":{"terminal":{"handle":"term_real"}}}'`, async (cli, dir) => {
    const orca = createOrcaCli({ command: cli, environment: 'my-server' })
    assert.deepEqual(await orca(['terminal', 'read', '--terminal', 'term_a']), {
      ok: true,
      result: { terminal: { handle: 'term_real' } }
    })
    assert.equal(await readFile(join(dir, 'args'), 'utf8'), 'terminal read --terminal term_a --json\n')
    assert.equal(await readFile(join(dir, 'env'), 'utf8'), 'my-server')
    // With no server set, the one the worker was started with is not passed on, nor is a pairing code.
    const own = createOrcaCli({
      command: cli,
      environment: '',
      env: { PATH: process.env.PATH, ORCA_ENVIRONMENT: 'laptop', ORCA_PAIRING_CODE: 'example-pairing-code' }
    })
    await own(['terminal', 'list'])
    assert.equal(await readFile(join(dir, 'args'), 'utf8'), 'terminal list --json\n')
    assert.equal(await readFile(join(dir, 'env'), 'utf8'), '')
    assert.equal(await readFile(join(dir, 'pairing'), 'utf8'), '')
  })
})

posixTest('a command that is not there fails as one not found', async () => {
  const command = join(tmpdir(), 'no-such-orca-cli')
  const orca = createOrcaCli({ command, environment: '' })
  assert.deepEqual(await orca(['terminal', 'list']), { ok: false, code: 'ENOENT', message: `the Orca CLI was not found: ${command}` })
})

posixTest('stopping ends a call in flight, and no call follows it', async () => {
  await withStandIn(
    (dir) => `printf '%s' "$$" > '${dir}/pid'\nexec sleep 30`,
    async (cli, dir) => {
      const orca = createOrcaCli({ command: cli, environment: '' })
      const call = orca(['terminal', 'read'])
      // The stand-in notes its pid as it starts.
      let pid = ''
      for (let waited = 0; pid === '' && waited < 2_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        pid = await readFile(join(dir, 'pid'), 'utf8').catch(() => '')
      }
      assert.match(pid, /^\d+$/)
      orca.stop()
      // At once: the call in flight is ended, not left to its timeout.
      const stoppedAt = performance.now()
      assert.deepEqual(await call, { ok: false, code: 'timeout', message: 'no answer from the Orca CLI in 8 s' })
      assert.ok(performance.now() - stoppedAt < 2_000, 'the call in flight outlived the stop')
      assert.throws(() => process.kill(Number(pid), 0))
      assert.deepEqual(await orca(['terminal', 'read']), { ok: false, code: 'stopped', message: 'the plugin is stopping' })
    }
  )
})
