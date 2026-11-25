// The remote mode against an Orca CLI that is the test's own: one terminal opened, read, lost
// and opened again, and closed at the end. The clock is the test's too, so no wait here is real.

import { assert, test } from 'orca/testing'
import { formatStatusText } from './metrics'
import type { CliOutcome, OrcaCli } from './orca-cli'
import { createRemoteSource, fallbackWorkspaceName, type RemoteConfig, type RemoteSource } from './remote'
import { STATS_MARKER, STATS_TITLE, statsCommand } from './stats-command'

/** Two made-up selectors, as `orca worktree ps --json` gives them: the workspace measured, and another one. */
const WORKSPACE = 'id:11111111-1111-1111-1111-111111111111::/home/me/projects/site'
const OTHER = 'id:abc::/home/me/projects/other-site'
const SECOND = 1_000
/** What Orca shows the workspace as: short enough for the bar. */
const NAME = 'stats-site'

/** One line of the script, as a terminal holds it: CPU in tenths of a percent. The values are made up. */
const line = (seq: number, cpu = 120): string =>
  `${STATS_MARKER}{"v":1,"seq":${seq},"cpu":${cpu},"cores":4,"mem":[8388608,2097152],"temp":[{"t":"acpitz","c":63000}],"load":"1.00 2.00 3.00","up":1000.5,"model":"Example CPU Model 000 w/ Example GPU Graphics"}`

// What the real CLI answered, in the shapes it answers in.
const shown = (displayName: unknown): CliOutcome => ({ ok: true, result: { worktree: { displayName } } })
const listed = (...terminals: { handle: string; title: string }[]): CliOutcome => ({ ok: true, result: { terminals } })
const created = (handle: string): CliOutcome => ({ ok: true, result: { terminal: { handle } } })
const running = (...tail: string[]): CliOutcome => ({ ok: true, result: { terminal: { status: 'running', tail } } })
const exited = (): CliOutcome => ({ ok: true, result: { terminal: { status: 'exited', tail: [] } } })
const stale = (): CliOutcome => ({ ok: false, code: 'terminal_handle_stale', message: 'terminal_handle_stale' })
const unknown = (): CliOutcome => ({ ok: false, code: 'invalid_argument', message: 'Unknown environment: nope' })
const failed = (code: string, message = code): CliOutcome => ({ ok: false, code, message })

type Answer = CliOutcome | Error | Promise<CliOutcome>

/** An Orca CLI that is the test's: every call is noted, and answered as `answer` says; an `Error` is thrown. */
function fakeCli(answer: (args: readonly string[]) => Answer): {
  cli: OrcaCli
  calls: string[][]
  waits: Array<number | undefined>
  stopped(): boolean
} {
  const calls: string[][] = []
  const waits: Array<number | undefined> = []
  let stopped = false
  const cli = async (args: readonly string[], options?: { timeoutMs?: number }): Promise<CliOutcome> => {
    calls.push([...args])
    waits.push(options?.timeoutMs)
    if (stopped) {
      return { ok: false, code: 'stopped', message: 'the plugin is stopping' }
    }
    const reply = await answer(args)
    if (reply instanceof Error) {
      throw reply
    }
    return reply
  }
  cli.stop = (): void => {
    stopped = true
  }
  return { cli, calls, waits, stopped: () => stopped }
}

const config = (overrides: Partial<RemoteConfig> = {}): RemoteConfig => ({
  environment: '',
  targetWorkspace: WORKSPACE,
  orcaCli: 'orca',
  refreshSeconds: 5,
  ...overrides
})

/** A source over the test's CLI, clock and log; `closeWaitMs` is for the tests of closing itself. */
function setup(
  answer: (args: readonly string[]) => Answer,
  overrides: Partial<RemoteConfig> = {},
  closeWaitMs?: number
): { source: RemoteSource; calls: string[][]; waits: Array<number | undefined>; stopped(): boolean; clock: { now: number }; logs: string[] } {
  const clock = { now: 10_000 }
  const logs: string[] = []
  const fake = fakeCli(answer)
  const source = createRemoteSource({
    config: config(overrides),
    cli: fake.cli,
    now: () => clock.now,
    log: (message) => logs.push(message),
    closeWaitMs
  })
  return { source, calls: fake.calls, waits: fake.waits, stopped: fake.stopped, clock, logs }
}

test('the workspace as the item can name it before Orca has told its name', () => {
  assert.equal(fallbackWorkspaceName(WORKSPACE), 'site')
  assert.equal(fallbackWorkspaceName(OTHER), 'other-site')
  assert.equal(fallbackWorkspaceName('identity:wt2:local:example-key'), 'wt2:local:example-key')
  assert.equal(fallbackWorkspaceName('id:abc::/home/me/My Project/'), 'My Project')
  assert.equal(fallbackWorkspaceName('x'.repeat(80)), 'x'.repeat(31) + '…')
})

/**
 * A server behind the CLI that is the test's own: at most one terminal, open while `state.open`
 * holds its handle and holding the lines `state.tail` holds; what is left from earlier runs is
 * `state.left`. What the test changes, the next call sees.
 */
function served(show: CliOutcome = shown(NAME)): {
  state: { open: string | null; tail: string[]; left: { handle: string; title: string }[]; created: number; failCreate: Answer | null }
  answer: (args: readonly string[]) => Answer
} {
  const state = { open: null as string | null, tail: [] as string[], left: [] as { handle: string; title: string }[], created: 0, failCreate: null as Answer | null }
  const answer = (args: readonly string[]): Answer => {
    const [, verb] = args
    if (args[0] === 'worktree') {
      return show
    }
    if (verb === 'list') {
      return listed(...state.left)
    }
    if (verb === 'create') {
      state.created += 1
      if (state.failCreate !== null) {
        return state.failCreate
      }
      state.open = `term_${state.created}`
      return created(state.open)
    }
    if (verb === 'read') {
      return state.open === null ? stale() : running(...state.tail)
    }
    return { ok: true, result: {} }
  }
  return { state, answer }
}

test('the first reading opens one terminal, names the workspace, and says a reading is on its way', async () => {
  const server = served()
  const { source, calls, waits } = setup(server.answer)
  const first = await source.read()
  assert.equal(first.snapshot.cpu, null)
  assert.deepEqual(first.snapshot.problems, ['waiting for the first reading'])
  assert.equal(first.retryInMs, 1_500)
  assert.deepEqual(first.snapshot.origin, { bar: NAME, tooltip: `${NAME} (this computer)` })
  assert.equal(formatStatusText(first.snapshot), `${NAME} · No host stats`)
  assert.deepEqual(calls, [
    ['worktree', 'show', '--worktree', WORKSPACE],
    ['terminal', 'list', '--worktree', WORKSPACE],
    [
      'terminal',
      'create',
      '--worktree',
      WORKSPACE,
      '--title',
      STATS_TITLE,
      '--command',
      statsCommand({ refreshSeconds: 5 })
    ]
  ])
  // Nothing is asked of the workspace again: reading is one call.
  server.state.tail = [line(1)]
  await source.read()
  await source.read()
  assert.deepEqual(calls.slice(3), [
    ['terminal', 'read', '--terminal', 'term_1', '--limit', '6'],
    ['terminal', 'read', '--terminal', 'term_1', '--limit', '6']
  ])
})

test('a reading is the newest whole line of the terminal, with the workspace first', async () => {
  const server = served()
  const { source, clock } = setup(server.answer)
  await source.read()
  server.state.tail = ['$ sh', line(1), line(2, 87), `${STATS_MARKER}{"v":1,"seq":3,"cpu":5`]
  const reading = await source.read()
  assert.equal(reading.snapshot.cpu?.percent, 8.7)
  assert.equal(reading.retryInMs, undefined)
  assert.equal(formatStatusText(reading.snapshot), `${NAME} · CPU 9% · RAM 2.0/8.0G · 63°C`)
  assert.deepEqual(reading.snapshot.problems, [])
  assert.equal(reading.snapshot.origin?.tooltip, `${NAME} (this computer)`)
  // The same line read again is the same reading, not a new one.
  clock.now += SECOND
  const again = await source.read()
  assert.equal(again.snapshot, reading.snapshot)
  // A terminal's output given as one text rather than lines is read the same.
  const whole = served()
  const flat = setup((args) =>
    args[1] === 'read' ? { ok: true, result: { terminal: { status: 'running', tail: `${line(1)}\n${line(2, 50)}\n` } } } : whole.answer(args)
  )
  await flat.source.read()
  assert.equal((await flat.source.read()).snapshot.cpu?.percent, 5)
})

test('a paired server is named on the bar, and the workspace with it in the tooltip', async () => {
  const server = served()
  const { source, calls } = setup(server.answer, { environment: ' my-server ' })
  const first = await source.read()
  assert.deepEqual(first.snapshot.origin, { bar: 'my-server', tooltip: `${NAME} on my-server` })
  // The server's own name is too long for the bar, and is cut short there.
  const long = served()
  const other = setup(long.answer, { environment: 'x'.repeat(40), targetWorkspace: OTHER }).source
  assert.deepEqual((await other.read()).snapshot.origin, { bar: 'x'.repeat(13) + '…', tooltip: `${NAME} on ${'x'.repeat(23)}…` })
  assert.equal(calls[2]?.[3], WORKSPACE)
})

test('the workspace is named as Orca shows it, or by its folder where Orca does not say', async () => {
  // A name Orca gives is cleaned to one short line.
  const named = served(shown('My\n  Site✓ '))
  const { source, calls } = setup(named.answer, { targetWorkspace: OTHER })
  assert.deepEqual((await source.read()).snapshot.origin, { bar: 'My Site✓', tooltip: 'My Site✓ (this computer)' })
  // Asked once: not again when the terminal is opened a second time.
  named.state.open = null
  await source.read()
  assert.equal(calls.filter((call) => call[0] === 'worktree').length, 1)
  // Where Orca says nothing usable, the folder the workspace is in.
  const unusable: CliOutcome[] = [
    failed('timeout', 'no answer from the Orca CLI in 8 s'),
    { ok: true, result: {} },
    shown(42),
    shown('   ')
  ]
  for (const show of unusable) {
    const server = served(show)
    const other = setup(server.answer, { targetWorkspace: OTHER }).source
    assert.deepEqual((await other.read()).snapshot.origin, { bar: 'other-site', tooltip: 'other-site (this computer)' }, JSON.stringify(show))
  }
})

test('a terminal left from an earlier run is closed before a new one is opened; other terminals are not', async () => {
  const server = served()
  server.state.left = [{ handle: 'term_old', title: STATS_TITLE }, { handle: 'term_user', title: 'zsh' }]
  const { source, calls } = setup(server.answer)
  await source.read()
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [['worktree', 'show'], ['terminal', 'list'], ['terminal', 'close'], ['terminal', 'create']]
  )
  assert.deepEqual(calls[2], ['terminal', 'close', '--terminal', 'term_old'])
  assert.equal(server.state.open, 'term_1')
})

test('a terminal lost is opened again after a wait, and the last reading stays meanwhile with why', async () => {
  const server = served()
  const { source, calls, clock, logs } = setup(server.answer)
  await source.read()
  server.state.tail = [line(1)]
  await source.read()
  const before = calls.length
  // Closed from outside, as a person closing the tab would.
  server.state.open = null
  clock.now += 5 * SECOND
  const lost = await source.read()
  assert.equal(formatStatusText(lost.snapshot), `${NAME} · CPU 12% · RAM 2.0/8.0G · 63°C`)
  assert.deepEqual(lost.snapshot.problems, ['the stats terminal is gone'])
  assert.equal(lost.retryInMs, SECOND)
  assert.deepEqual(logs, ['remote: the stats terminal is gone; opening the stats terminal again in 1 s'])
  // Until the wait is over, nothing more is asked of the CLI.
  clock.now += SECOND / 2
  assert.equal((await source.read()).retryInMs, SECOND / 2)
  assert.equal(calls.length, before + 1)
  // Then a new terminal, whose first reading is waited for as the first one was.
  clock.now += SECOND / 2
  const reopened = await source.read()
  assert.equal(reopened.retryInMs, 1_500)
  assert.equal(server.state.open, 'term_2')
  // A new script counts from 1 again, and its first line is a new reading.
  server.state.tail = [line(1, 40)]
  const fresh = await source.read()
  assert.equal(fresh.snapshot.cpu?.percent, 4)
  assert.deepEqual(fresh.snapshot.problems, [])
  assert.equal(fresh.retryInMs, undefined)
})

test('a terminal that exited, a stale handle and a CLI that throws all mean the terminal is lost', async () => {
  const cases: Array<[Answer, string]> = [
    [exited(), 'the stats terminal exited'],
    [stale(), 'the stats terminal is gone'],
    [new Error('ECONNRESET'), 'ECONNRESET']
  ]
  for (const [answer, problem] of cases) {
    const server = served()
    let broken = false
    const { source } = setup((args) => (broken && args[1] === 'read' ? answer : server.answer(args)))
    await source.read()
    server.state.tail = [line(1)]
    await source.read()
    broken = true
    // Never a rejected reading: what failed is said in it.
    const lost = await source.read()
    assert.deepEqual(lost.snapshot.problems, [problem])
    assert.equal(lost.snapshot.cpu?.percent, 12)
    assert.equal(lost.retryInMs, SECOND)
  }
})

test('each failure in a row waits longer before the next try, up to a minute, and a reading that comes starts it over', async () => {
  const server = served()
  const { source, clock, logs } = setup(server.answer)
  server.state.failCreate = unknown()
  const waits: number[] = []
  let failed = await source.read()
  for (let attempt = 0; attempt < 8; attempt++) {
    failed = await source.read()
    assert.deepEqual(failed.snapshot.problems, ['Unknown environment: nope'])
    assert.ok(failed.retryInMs !== undefined)
    waits.push(failed.retryInMs)
    // The next reading comes when the wait is over, as the loop makes it.
    clock.now += failed.retryInMs
  }
  assert.deepEqual(
    waits,
    [1, 2, 4, 8, 16, 32, 60, 60].map((seconds) => seconds * SECOND)
  )
  // No workspace to open a terminal in: nothing was ever read, and only why is shown.
  assert.equal(server.state.created, 8)
  assert.equal(formatStatusText(failed.snapshot), `${NAME} · No host stats`)
  assert.equal(failed.snapshot.origin?.tooltip, `${NAME} (this computer)`)
  // Said each time the wait changed, and once while it stayed the same.
  assert.equal(logs.length, 7)
  assert.equal(logs[0], 'remote: Unknown environment: nope; opening the stats terminal again in 1 s')
  assert.equal(logs.at(-1), 'remote: Unknown environment: nope; opening the stats terminal again in 60 s')
  // Back, and out again: the wait starts over from a second.
  server.state.failCreate = null
  server.state.tail = [line(1)]
  const back = await source.read()
  assert.deepEqual(back.snapshot.problems, ['waiting for the first reading'])
  assert.equal(back.retryInMs, 1_500)
  assert.deepEqual((await source.read()).snapshot.problems, [])
  server.state.open = null
  assert.equal((await source.read()).retryInMs, SECOND)
})

test('the last good reading is kept for two minutes while the terminal cannot be reopened, and no longer', async () => {
  const server = served()
  const { source, clock } = setup(server.answer)
  await source.read()
  server.state.tail = [line(1)]
  const good = await source.read()
  server.state.open = null
  server.state.failCreate = { ok: false, code: 'timeout', message: 'no answer from the Orca CLI in 15 s' }
  const kept: Array<[number, string]> = [
    [5, 'the stats terminal is gone'],
    [60, 'the Orca CLI did not answer in time'],
    [119, 'the Orca CLI did not answer in time']
  ]
  for (const [seconds, problem] of kept) {
    clock.now = 10_000 + seconds * SECOND
    const reading = await source.read()
    assert.equal(reading.snapshot.cpu, good.snapshot.cpu)
    assert.deepEqual(reading.snapshot.problems, [problem])
  }
  clock.now = 10_000 + 121 * SECOND
  const gone = await source.read()
  assert.equal(gone.snapshot.cpu, null)
  assert.deepEqual(gone.snapshot.problems, ['the Orca CLI did not answer in time'])
  assert.equal(formatStatusText(gone.snapshot), `${NAME} · No host stats`)
})

test('a terminal that prints nothing new for long is given up, and opened again after the wait', async () => {
  const cases: Array<[number, number, number | null]> = [
    // The reading interval, how long the terminal has been quiet, and the wait it is given up after.
    [5, 14, null],
    [5, 15, null],
    [5, 16, 15],
    [30, 60, null],
    [30, 90, null],
    [30, 91, 90]
  ]
  for (const [refreshSeconds, quietSeconds, stallSeconds] of cases) {
    const server = served()
    const { source, clock } = setup(server.answer, { refreshSeconds })
    await source.read()
    server.state.tail = [line(1)]
    await source.read()
    clock.now += quietSeconds * SECOND
    const reading = await source.read()
    const how = `${refreshSeconds} s readings, ${quietSeconds} s quiet`
    if (stallSeconds === null) {
      // The same line read again is still the last reading, and nothing is wrong.
      assert.deepEqual(reading.snapshot.problems, [], how)
    } else {
      assert.deepEqual(reading.snapshot.problems, [`no new reading for ${stallSeconds} s`], how)
      assert.equal(reading.snapshot.cpu?.percent, 12)
      assert.equal(reading.retryInMs, SECOND)
      clock.now += SECOND
      assert.equal(server.state.open, 'term_1')
      await source.read()
      assert.equal(server.state.open, 'term_2')
    }
  }
})

test('a terminal created without a handle is not kept', async () => {
  const server = served()
  const noHandle: CliOutcome = { ok: true, result: { terminal: {} } }
  const { source, calls } = setup((args) => (args[1] === 'create' ? noHandle : server.answer(args)))
  const reading = await source.read()
  assert.deepEqual(reading.snapshot.problems, ['the Orca CLI gave no terminal handle'])
  assert.equal(reading.retryInMs, SECOND)
  assert.equal(calls.some((call) => call[1] === 'read'), false)
})

test('what cannot be listed is not opened, since one may be there already', async () => {
  const server = served()
  const { source, calls } = setup((args) =>
    args[1] === 'list' ? failed('timeout', 'no answer from the Orca CLI in 8 s') : server.answer(args)
  )
  assert.deepEqual((await source.read()).snapshot.problems, ['the Orca CLI did not answer in time'])
  assert.equal(calls.some((call) => call[1] === 'create'), false)
})

test('a workspace that is not there is said so, and no terminal is read', async () => {
  const server = served()
  const { source, calls } = setup((args) => (args[1] === 'create' ? failed('selector_not_found') : server.answer(args)))
  const reading = await source.read()
  assert.deepEqual(reading.snapshot.problems, ['no workspace has this selector'])
  assert.equal(reading.retryInMs, SECOND)
  assert.equal(calls.some((call) => call[1] === 'read'), false)
})

test('opening a terminal may take longer than reading it, and the terminal runs the script for the interval set', async () => {
  const server = served()
  const { source, calls, waits } = setup(server.answer, { refreshSeconds: 30 })
  await source.read()
  server.state.tail = [line(1)]
  await source.read()
  assert.deepEqual(waits.slice(0, 4), [undefined, undefined, 15_000, undefined])
  assert.equal(calls[2]?.at(-1), statsCommand({ refreshSeconds: 30 }))
  assert.ok(calls[2]?.at(-1)?.includes('; i=5;'))
})

test('one call at a time: a reading that finds one in flight shows what the last one found', async () => {
  const server = served()
  let release = (): void => undefined
  let started = (): void => undefined
  const begun = new Promise<void>((resolve) => {
    started = resolve
  })
  const { source, calls } = setup((args) => {
    if (args[1] === 'read') {
      return new Promise<CliOutcome>((resolve) => {
        release = () => resolve(running(line(1)))
        started()
      })
    }
    return server.answer(args)
  })
  await source.read()
  const held = source.read()
  await begun
  const meanwhile = await source.read()
  assert.equal(meanwhile.snapshot.cpu, null)
  assert.equal(calls.filter((call) => call[1] === 'read').length, 1)
  release()
  assert.equal((await held).snapshot.cpu?.percent, 12)
})

test('closing closes the terminal and ends the CLI, and a reading after that asks nothing', async () => {
  const server = served()
  const { source, calls, stopped } = setup(server.answer)
  await source.read()
  await source.close()
  assert.deepEqual(calls.at(-1), ['terminal', 'close', '--terminal', 'term_1'])
  assert.equal(stopped(), true)
  const before = calls.length
  assert.equal((await source.read()).snapshot.cpu, null)
  await source.close()
  assert.equal(calls.length, before)
  // Before anything was opened, there is nothing to close.
  const fresh = setup(served().answer)
  await fresh.source.close()
  assert.equal(fresh.calls.length, 0)
  assert.equal(fresh.stopped(), true)
})

test('closing while a terminal is being opened closes it as soon as it is there', async () => {
  const server = served()
  let release = (): void => undefined
  let started = (): void => undefined
  const begun = new Promise<void>((resolve) => {
    started = resolve
  })
  const { source, calls } = setup((args) => {
    if (args[1] === 'create') {
      return new Promise<CliOutcome>((resolve) => {
        release = () => resolve(created('term_late'))
        started()
      })
    }
    return server.answer(args)
  })
  const reading = source.read()
  await begun
  const closing = source.close()
  release()
  const [opened] = await Promise.all([reading, closing])
  assert.deepEqual(calls.at(-1), ['terminal', 'close', '--terminal', 'term_late'])
  assert.equal(calls.some((call) => call[1] === 'read'), false)
  assert.equal(opened.snapshot.cpu, null)
})

test('a terminal that finishes opening after closing gave up waiting for it is closed all the same', async () => {
  const server = served()
  let release = (): void => undefined
  let started = (): void => undefined
  const begun = new Promise<void>((resolve) => {
    started = resolve
  })
  const { source, calls } = setup((args) => {
    if (args[1] === 'create') {
      return new Promise<CliOutcome>((resolve) => {
        release = () => resolve(created('term_late'))
        started()
      })
    }
    return server.answer(args)
  }, {}, 20)
  const reading = source.read()
  await begun
  // Closing waits only a moment for it, then ends the CLI calls.
  await source.close()
  // The answer was already on its way, and comes all the same.
  release()
  await reading
  assert.deepEqual(calls.at(-1), ['terminal', 'close', '--terminal', 'term_late'])
})

test('closing while a reading is in flight does not wait for the reading', async () => {
  const server = served()
  let end = (): void => undefined
  let started = (): void => undefined
  const begun = new Promise<void>((resolve) => {
    started = resolve
  })
  const { source, calls, logs } = setup((args) => {
    if (args[1] === 'read') {
      // A call that hangs until it is ended, as one whose process is killed is.
      return new Promise<CliOutcome>((resolve) => {
        end = () => resolve({ ok: false, code: 'timeout', message: '' })
        started()
      })
    }
    return server.answer(args)
  })
  await source.read()
  const hung = source.read()
  await begun
  const startedAt = performance.now()
  await source.close()
  assert.ok(performance.now() - startedAt < 2_000, 'closing waited for the reading')
  assert.deepEqual(calls.at(-1), ['terminal', 'close', '--terminal', 'term_1'])
  assert.equal(logs.length, 0)
  // The reading ends without a word once the CLI is stopped.
  end()
  assert.equal((await hung).retryInMs, undefined)
  assert.deepEqual(logs, [])
})
