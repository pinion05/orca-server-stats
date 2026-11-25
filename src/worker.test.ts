// The poll, the sampling behind it, and the worker as Orca starts it. Timers and readings are the
// test's own, so nothing here waits on a real interval or needs a real sensor.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { createCollector } from './collector'
import { logOnce } from './log'
import {
  STATUS_TEXT_MAX,
  TOOLTIP_MAX,
  type CpuTimes,
  type GpuUsage,
  type MemoryUsage,
  type MetricsSnapshot,
  type StatusItem,
  type TemperatureReading
} from './metrics'
import { STATS_MARKER } from './stats-command'
import type { Reading, SystemReader } from './system'
import * as main from './worker'
import {
  configOf,
  DEFAULT_ORCA_CLI,
  DEFAULT_REFRESH_SECONDS,
  intervalSecondsOf,
  ITEM_ID,
  refreshSecondsOf,
  remoteKeyOf,
  remoteRefreshSecondsOf,
  REMOTE_REFRESH_SECONDS,
  startLoop,
  type Loop,
  type LoopOptions,
  type Reading as LoopReading,
  type Scheduler
} from './worker'

/** Timers the test fires by hand. `pending()` is what each waiting timer was told to wait. */
function manualTimers(): { scheduler: Scheduler; pending(): number[]; fire(): void } {
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  let next = 1
  return {
    scheduler: {
      set: (callback, delayMs) => {
        const id = next++
        timers.set(id, { callback, delayMs })
        return id
      },
      clear: (handle) => {
        timers.delete(handle as number)
      }
    },
    pending: () => [...timers.values()].map((timer) => timer.delayMs),
    fire: () => {
      const first = timers.entries().next()
      if (first.done) {
        throw new Error('no timer is waiting')
      }
      timers.delete(first.value[0])
      first.value[1].callback()
    }
  }
}

const plain = (cpuPercent: number): MetricsSnapshot => ({
  cpu: { percent: cpuPercent, cores: 4 },
  memory: null,
  temperatures: [],
  gpu: null,
  cpuModel: null,
  load: null,
  uptimeSeconds: null,
  problems: [],
  origin: null
})

/** Far outside every test but the ones about it: a tick's limit while one reading is 2 seconds. */
const TICK_LIMIT = 60_000

/** A loop over a clock that never moves, so every wait is the whole interval. */
function manualLoop(overrides: Partial<LoopOptions> = {}): {
  loop: Loop
  timers: ReturnType<typeof manualTimers>
  sent: StatusItem[]
  logs: string[]
} {
  const timers = manualTimers()
  const sent: StatusItem[] = []
  const logs: string[] = []
  const loop = startLoop({
    sample: async () => ({ snapshot: plain(10) }),
    publish: async (item) => {
      sent.push(item)
    },
    intervalMs: () => 2_000,
    log: (message) => {
      logs.push(message)
    },
    scheduler: timers.scheduler,
    now: () => 1_000,
    tickLimitMs: TICK_LIMIT,
    ...overrides
  })
  return { loop, timers, sent, logs }
}

test('publishes the first reading at once, then one per interval', async () => {
  const readings = [plain(10), plain(20), plain(30)]
  const { loop, timers, sent } = manualLoop({
    sample: async () => ({ snapshot: readings.shift() ?? plain(0) })
  })
  loop.start()
  assert.deepEqual(timers.pending(), [0])
  for (const expected of ['CPU 10%', 'CPU 20%', 'CPU 30%']) {
    timers.fire()
    await loop.run()
    assert.equal(sent.at(-1)?.text, expected)
    assert.deepEqual(timers.pending(), [2_000])
  }
})

test('sends an item again only when it changed', async () => {
  let percent = 10
  const { loop, timers, sent } = manualLoop({ sample: async () => ({ snapshot: plain(percent) }) })
  loop.start()
  timers.fire()
  await loop.run()
  timers.fire()
  await loop.run()
  assert.equal(sent.length, 1)
  percent = 11
  timers.fire()
  await loop.run()
  assert.deepEqual(
    sent.map((item) => item.text),
    ['CPU 10%', 'CPU 11%']
  )
})

test('keeps going when a reading fails, and keeps the last good text', async () => {
  const failure = new Error('EIO')
  const { loop, timers, sent, logs } = manualLoop({
    sample: async () => {
      throw failure
    }
  })
  loop.start()
  timers.fire()
  await loop.run()
  timers.fire()
  await loop.run()
  assert.deepEqual(sent, [])
  assert.deepEqual(timers.pending(), [2_000])
  // The same failure is logged once, not on every tick.
  assert.deepEqual(logs, ['update failed: EIO'])
})

test('keeps going when Orca refuses the update, slowly after a few in a row', async () => {
  let refusing = true
  let accepted = 0
  const { loop, timers, logs } = manualLoop({
    publish: async () => {
      if (refusing) {
        throw Object.assign(new Error('this Orca has no status bar'), { code: 'unavailable' })
      }
      accepted += 1
    }
  })
  loop.start()
  for (const expected of [2_000, 2_000, 10_000, 10_000]) {
    timers.fire()
    await loop.run()
    assert.deepEqual(timers.pending(), [expected])
  }
  assert.equal(accepted, 0)
  assert.deepEqual(logs, ['status bar update failed: this Orca has no status bar'])
  refusing = false
  timers.fire()
  await loop.run()
  assert.equal(accepted, 1)
  assert.deepEqual(timers.pending(), [2_000])
})

test('waits as long as a rate limit asks', async () => {
  const { loop, timers } = manualLoop({
    publish: async () => {
      throw Object.assign(new Error('too many updates'), { code: 'rate_limited', retryAfterMs: 7_000 })
    }
  })
  loop.start()
  timers.fire()
  await loop.run()
  assert.deepEqual(timers.pending(), [7_000])
})

test('what a rate limit asks for comes before a source wanting the next reading sooner', async () => {
  const { loop, timers } = manualLoop({
    sample: async () => ({ snapshot: plain(10), retryInMs: 500 }),
    publish: async () => {
      throw Object.assign(new Error('too many updates'), { code: 'rate_limited', retryAfterMs: 7_000 })
    }
  })
  loop.start()
  timers.fire()
  await loop.run()
  assert.deepEqual(timers.pending(), [7_000])
})

test('asks again soon when the source says the next reading is worth it, but never at once', async () => {
  const cases: Array<[number, number]> = [
    [500, 500],
    [0, 250],
    [100, 250]
  ]
  for (const [retryInMs, expected] of cases) {
    const { loop, timers } = manualLoop({ sample: async () => ({ snapshot: plain(10), retryInMs }) })
    loop.start()
    timers.fire()
    await loop.run()
    assert.deepEqual(timers.pending(), [expected])
  }
})

test('never runs two ticks at once', async () => {
  let release = (): void => undefined
  let started = (): void => undefined
  const begun = new Promise<void>((resolve) => {
    started = resolve
  })
  const { loop, timers, sent } = manualLoop({
    sample: () =>
      new Promise<LoopReading>((resolve) => {
        release = () => resolve({ snapshot: plain(10) })
        started()
      })
  })
  loop.start()
  timers.fire()
  const first = loop.run()
  await begun
  // While the tick runs, only its limit is waiting.
  assert.deepEqual(timers.pending(), [TICK_LIMIT])
  assert.equal(loop.run(), first)
  release()
  await first
  assert.equal(sent.length, 1)
  assert.deepEqual(timers.pending(), [2_000])
})

test('a tick that finishes after a stop publishes nothing and schedules nothing', async () => {
  let release = (): void => undefined
  let started = (): void => undefined
  const begun = new Promise<void>((resolve) => {
    started = resolve
  })
  const { loop, timers, sent } = manualLoop({
    sample: () =>
      new Promise<LoopReading>((resolve) => {
        release = () => resolve({ snapshot: plain(10) })
        started()
      })
  })
  loop.start()
  timers.fire()
  const tick = loop.run()
  await begun
  loop.stop()
  release()
  await tick
  assert.deepEqual(sent, [])
  assert.deepEqual(timers.pending(), [])
})

test('a stop cancels the next tick, and a kick brings it forward', async () => {
  const { loop, timers } = manualLoop()
  loop.start()
  timers.fire()
  await loop.run()
  assert.deepEqual(timers.pending(), [2_000])
  loop.kick()
  assert.deepEqual(timers.pending(), [0])
  loop.stop()
  assert.deepEqual(timers.pending(), [])
})

test('applies a changed interval from the next tick on', async () => {
  let interval = 2_000
  const { loop, timers } = manualLoop({ intervalMs: () => interval })
  loop.start()
  timers.fire()
  await loop.run()
  assert.deepEqual(timers.pending(), [2_000])
  interval = 500
  timers.fire()
  await loop.run()
  assert.deepEqual(timers.pending(), [500])
})

test('a slow reading does not make the next one follow at once', async () => {
  let now = 1_000
  const { loop, timers } = manualLoop({
    now: () => now,
    sample: async () => {
      now += 2_500
      return { snapshot: plain(10) }
    }
  })
  loop.start()
  timers.fire()
  await loop.run()
  // A quarter of a second at the least, whatever the clock says.
  assert.deepEqual(timers.pending(), [250])
})

test('a reading that does not come back does not hold the loop, and a late one shows only until a newer reading begins', async () => {
  let now = 1_000
  let hold = false
  let release = (): void => undefined
  let started = (): void => undefined
  let begun = Promise.resolve()
  const { loop, timers, sent, logs } = manualLoop({
    tickLimitMs: 1_000,
    now: () => now,
    sample: () => {
      if (!hold) {
        return Promise.resolve({ snapshot: plain(10) })
      }
      hold = false
      // One reading that stays out until the test lets it go, with a number of its own; by the clock
      // it has already taken most of the interval.
      now += 1_500
      begun = new Promise<void>((resolve) => {
        started = resolve
      })
      return new Promise<LoopReading>((resolve) => {
        release = () => resolve({ snapshot: plain(99) })
        started()
      })
    }
  })
  loop.start()
  hold = true
  timers.fire()
  await begun
  assert.deepEqual(timers.pending(), [1_000])
  // The limit passes: the next tick is scheduled a whole interval later, not the part left of this one.
  timers.fire()
  await loop.run()
  assert.deepEqual(timers.pending(), [2_000])
  assert.equal(sent.length, 0)
  assert.deepEqual(logs, ['a reading took longer than 1 s; the next one follows'])
  // The late reading arrives before the next tick. Nothing newer has been read, so it is shown...
  release()
  await settle()
  assert.deepEqual(
    sent.map((item) => item.text),
    ['CPU 99%']
  )
  // ...and it schedules nothing of its own.
  assert.deepEqual(timers.pending(), [2_000])

  // Again, with the next tick reading first this time.
  hold = true
  timers.fire()
  await begun
  timers.fire()
  await loop.run()
  assert.deepEqual(timers.pending(), [2_000])
  timers.fire()
  await loop.run()
  assert.deepEqual(
    sent.map((item) => item.text),
    ['CPU 99%', 'CPU 10%']
  )
  // The late reading is now older than what is shown, and is dropped.
  release()
  await settle()
  assert.deepEqual(
    sent.map((item) => item.text),
    ['CPU 99%', 'CPU 10%']
  )
  assert.deepEqual(timers.pending(), [2_000])
})

test('reads the refresh setting as a number of seconds within what the manifest allows', () => {
  assert.equal(refreshSecondsOf(undefined), DEFAULT_REFRESH_SECONDS)
  assert.equal(refreshSecondsOf(''), DEFAULT_REFRESH_SECONDS)
  assert.equal(refreshSecondsOf('soon'), DEFAULT_REFRESH_SECONDS)
  assert.equal(refreshSecondsOf(5), 5)
  assert.equal(refreshSecondsOf('5'), 5)
  assert.equal(refreshSecondsOf(2.6), 3)
  assert.equal(refreshSecondsOf(0.2), 1)
  assert.equal(refreshSecondsOf(600), 60)
})

test('a workspace\'s machine is read every five seconds unless three or more are set', () => {
  assert.equal(REMOTE_REFRESH_SECONDS, 5)
  assert.equal(remoteRefreshSecondsOf(1), 5)
  assert.equal(remoteRefreshSecondsOf(2), 5)
  assert.equal(remoteRefreshSecondsOf(3), 3)
  assert.equal(remoteRefreshSecondsOf(30), 30)
  const local = configOf({})
  assert.equal(local.remote, false)
  assert.equal(local.orcaCli, DEFAULT_ORCA_CLI)
  assert.equal(intervalSecondsOf(local), DEFAULT_REFRESH_SECONDS)
  const remote = configOf({
    source: 'remote',
    environment: ' my-server ',
    targetWorkspace: 'id:11111111-1111-1111-1111-111111111111::/home/me/projects/site',
    orcaCli: '',
    refreshSeconds: '2'
  })
  assert.deepEqual(remote, {
    remote: true,
    environment: 'my-server',
    targetWorkspace: 'id:11111111-1111-1111-1111-111111111111::/home/me/projects/site',
    orcaCli: DEFAULT_ORCA_CLI,
    refreshSeconds: 2
  })
  assert.equal(intervalSecondsOf(remote), 5)
  assert.equal(intervalSecondsOf({ ...remote, refreshSeconds: 4 }), 4)
  // A new terminal is needed when the target, the server, the command or the interval changes.
  assert.equal(remoteKeyOf(remote), remoteKeyOf({ ...remote, refreshSeconds: 2 }))
  assert.notEqual(remoteKeyOf(remote), remoteKeyOf({ ...remote, refreshSeconds: 8 }))
  assert.notEqual(remoteKeyOf(remote), remoteKeyOf({ ...remote, targetWorkspace: 'id:other::/x' }))
})

test('a message is passed on once while it repeats, and again after a reset', () => {
  const lines: string[] = []
  const log = logOnce((message: string) => {
    lines.push(message)
  })
  log('same')
  log('same')
  log('other')
  log('same')
  log.reset()
  log('same')
  assert.deepEqual(lines, ['same', 'other', 'same', 'same'])
})

/** Nothing, as a reading of whatever is asked for. */
const none = <T>(): Reading<T> => ({ value: null, problem: null }) as Reading<T>

type Script = {
  cpuTimes?: Array<Reading<CpuTimes | null>>
  memory?: Array<Reading<MemoryUsage | null>>
  temperatures?: Array<Reading<readonly TemperatureReading[]>>
  gpu?: Array<Reading<GpuUsage | null>>
}

/** A reader the test scripts: each call takes the next answer, or repeats the last one. */
function scriptedReader(script: Script = {}): { reader: SystemReader; gpuAt: number[] } {
  const gpuAt: number[] = []
  const take = <T>(answers: Array<Reading<T>> | undefined): Reading<T> | undefined =>
    answers && answers.length > 1 ? (answers.shift() ?? answers[0]) : answers?.[0]
  const reader: SystemReader = {
    cpuTimes: async () => take(script.cpuTimes) ?? none(),
    memory: async () => take(script.memory) ?? none(),
    temperatures: async () => take(script.temperatures) ?? { value: [], problem: null },
    gpu: async (now) => {
      gpuAt.push(now)
      return take(script.gpu) ?? none()
    }
  }
  return { reader, gpuAt }
}

test('the first CPU reading is measured over a short interval of its own, then between ticks', async () => {
  const waited: number[] = []
  const { reader } = scriptedReader({
    cpuTimes: [
      { value: { total: 1000, idle: 800 }, problem: null },
      { value: { total: 2000, idle: 1700 }, problem: null },
      { value: { total: 3000, idle: 2000 }, problem: null }
    ]
  })
  const collector = createCollector({
    reader,
    wait: async (ms) => {
      waited.push(ms)
    }
  })
  const first = await collector.sample()
  // Not the average since boot (20%), and not nothing: the use between two quick readings.
  assert.equal(first.cpu?.percent, 10)
  assert.equal(first.origin, null)
  assert.deepEqual(waited, [400])
  assert.equal((await collector.sample()).cpu?.percent, 70)
  // Two readings inside the same tick have nothing between them: the last use is kept, not dropped.
  assert.equal((await collector.sample()).cpu?.percent, 70)
  assert.deepEqual(waited, [400])
})

test('names what could not be read, in the snapshot', async () => {
  const { reader } = scriptedReader({
    cpuTimes: [{ value: null, problem: 'CPU (EACCES)' }],
    memory: [{ value: null, problem: 'RAM (/proc/meminfo unreadable)' }],
    temperatures: [{ value: [], problem: 'temperature (no readable sensor)' }],
    gpu: [{ value: null, problem: 'nvidia-smi (exit 9)' }]
  })
  const snapshot = await createCollector({ reader, wait: async () => undefined }).sample()
  assert.deepEqual(snapshot.problems, [
    'CPU (EACCES)',
    'RAM (/proc/meminfo unreadable)',
    'temperature (no readable sensor)',
    'nvidia-smi (exit 9)'
  ])
  assert.equal(snapshot.cpu, null)
  assert.equal(snapshot.memory, null)
  assert.deepEqual(snapshot.temperatures, [])
  assert.equal(snapshot.gpu, null)
  // A machine with no GPU to report and nothing wrong says nothing.
  const quiet = scriptedReader()
  assert.deepEqual((await createCollector({ reader: quiet.reader, wait: async () => undefined }).sample()).problems, [])
})

test('a reader that throws loses its own metric and none of the others', async () => {
  const broken = Object.assign(new Error('reading failed'), { code: 'EIO' })
  const { reader } = scriptedReader({
    cpuTimes: [
      { value: { total: 1000, idle: 800 }, problem: null },
      { value: { total: 2000, idle: 1700 }, problem: null }
    ],
    memory: [{ value: { usedBytes: 1, totalBytes: 2, percent: 50 }, problem: null }]
  })
  const flaky: SystemReader = {
    cpuTimes: reader.cpuTimes,
    memory: reader.memory,
    temperatures: async () => {
      throw broken
    },
    gpu: async () => {
      throw broken
    }
  }
  const snapshot = await createCollector({ reader: flaky, wait: async () => undefined }).sample()
  assert.equal(snapshot.cpu?.percent, 10)
  assert.equal(snapshot.memory?.percent, 50)
  assert.deepEqual(snapshot.problems, ['temperature (EIO)', 'GPU (EIO)'])
})

test('asks the GPU reader for the time of the reading', async () => {
  const { reader, gpuAt } = scriptedReader()
  const before = performance.now()
  await createCollector({ reader, wait: async () => undefined }).sample()
  assert.equal(gpuAt.length, 1)
  assert.ok(gpuAt[0] >= before && gpuAt[0] <= performance.now())
})

test('the worker updates the item the manifest declares, in a shape Orca accepts', async () => {
  const updates: StatusItem[] = []
  let arrive = (): void => undefined
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const host = mockHost({
    results: {
      // The stand-in host checks what Orca would before answering: the item and the length of its text.
      'statusBar.update': (params: StatusItem) => {
        updates.push(params)
        arrive()
        return { ok: true }
      }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    await Promise.race([arrived, givesUp()])
    const [item] = updates
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../orca-plugin.json', import.meta.url)), 'utf8')
    ) as { contributes: { statusBarItems: { id: string }[] } }
    assert.equal(manifest.contributes.statusBarItems[0]?.id, ITEM_ID)
    assert.equal(item?.id, ITEM_ID)
    assert.equal(item?.visible, true)
    assert.ok(item.text.length > 0 && item.text.length <= STATUS_TEXT_MAX)
    assert.ok(item.tooltip.length <= TOOLTIP_MAX)
    assert.equal(host.callsOf('settings.get').length, 1)
    // Nothing Orca would have refused, and nothing to report.
    assert.deepEqual(worker.refusals, [])
    assert.deepEqual(worker.logs, [])
  } finally {
    await worker.deactivate()
  }
})

test('the refresh setting reaches the loop: at a second, a third reading is due long before the default two would have it', async () => {
  const at: number[] = []
  const host = mockHost({
    settings: { refreshSeconds: 1 },
    results: {
      'statusBar.update': () => {
        at.push(performance.now())
        return { ok: true }
      }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    // The first reading waits 0.4 s for a second CPU sample, the next follow a second later; a reading
    // is sent only when the item changed, so one of the three may be still.
    await waitsUntil(() => at.length >= 3)
    const between = Math.round(at[2] - at[0])
    assert.ok(between < 3_000, `${between} ms between the first reading and the third`)
  } finally {
    await worker.deactivate()
  }
})

test('the worker starts even when the settings cannot be read at first, and reads them later', async () => {
  const updates: StatusItem[] = []
  let arrive = (): void => undefined
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve
  })
  let settingsReads = 0
  let readAgain = (): void => undefined
  const readAgainPromise = new Promise<void>((resolve) => {
    readAgain = resolve
  })
  const host = mockHost({
    results: {
      'statusBar.update': (params: StatusItem) => {
        updates.push(params)
        arrive()
        return { ok: true }
      },
      'settings.get': () => {
        settingsReads += 1
        if (settingsReads === 1) {
          throw hostError('unavailable', 'the settings store is starting')
        }
        readAgain()
        return { settings: {} }
      }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    await Promise.race([arrived, givesUp()])
    // The first reading came all the same, from this machine, and the failure was said once.
    assert.ok(updates[0]?.text.startsWith('CPU '))
    assert.ok(worker.logs.some((line) => line.startsWith('could not read the settings, using the defaults')))
    // The next tick, two seconds later on the default interval, reads them again and gets them.
    await Promise.race([readAgainPromise, givesUp()])
    assert.ok(settingsReads >= 2)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

test('a workspace\'s machine with no Orca CLI to reach it says so, and the worker goes on', async () => {
  const updates: StatusItem[] = []
  let arrive = (): void => undefined
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const host = mockHost({
    settings: {
      source: 'remote',
      targetWorkspace: 'id:00000000-0000-0000-0000-000000000000::/nowhere',
      orcaCli: join(tmpdir(), 'no-such-orca-cli')
    },
    results: {
      'statusBar.update': (params: StatusItem) => {
        updates.push(params)
        arrive()
        return { ok: true }
      }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    await Promise.race([arrived, givesUp()])
    const [item] = updates
    assert.equal(item?.text, 'nowhere · No host stats')
    assert.equal(item?.tooltip, 'nowhere (this computer) · unavailable: Orca CLI not found (see the Orca CLI setting)')
    assert.deepEqual(worker.refusals, [])
  } finally {
    // Stopping closes the terminal if one was opened; here none was.
    await worker.deactivate()
  }
})

test('a workspace\'s machine without a workspace set says what is missing', async () => {
  const updates: StatusItem[] = []
  let arrive = (): void => undefined
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const host = mockHost({
    settings: { source: 'remote' },
    results: {
      'statusBar.update': (params: StatusItem) => {
        updates.push(params)
        arrive()
        return { ok: true }
      }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    await Promise.race([arrived, givesUp()])
    assert.equal(updates[0]?.text, 'No host stats')
    assert.equal(updates[0]?.tooltip, 'unavailable: set the workspace to measure (targetWorkspace)')
  } finally {
    await worker.deactivate()
  }
})

/** Gives up waiting for an update after a while, so a worker that never sends one fails the test. */
function givesUp(): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('no status bar update arrived')), 8_000)
  })
}

/** Resolves once `ready` holds, looked at every few milliseconds; fails the test if it never does. */
async function waitsUntil(ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready() && waited < 8_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(ready(), 'the update never came')
}

if (process.platform !== 'win32') {
  test('for a workspace\'s machine the worker reaches it through the Orca CLI, and closes its terminal when it stops', async () => {
    // A stand-in for the Orca CLI, run as the real one is: it notes its calls, opens one terminal,
    // and has the stats script's line in it.
    const dir = await mkdtemp(join(tmpdir(), 'server-stats-orca-'))
    const cli = join(dir, 'orca')
    await writeFile(
      cli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs')",
        'const args = process.argv.slice(2)',
        `fs.appendFileSync('${join(dir, 'calls')}', args.slice(0, 2).join(' ') + '\\n')`,
        "const answer = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n')",
        "switch (args.slice(0, 2).join(' ')) {",
        "  case 'worktree show': answer({ worktree: { displayName: 'site' } }); break",
        "  case 'terminal list': answer({ terminals: [] }); break",
        "  case 'terminal create': answer({ terminal: { handle: 'term_1' } }); break",
        `  case 'terminal read': answer({ terminal: { status: 'running', tail: [fs.readFileSync('${join(dir, 'reading')}', 'utf8').trim()] } }); break`,
        '  default: answer({})',
        '}',
        ''
      ].join('\n')
    )
    await writeFile(
      join(dir, 'reading'),
      `${STATS_MARKER}{"v":1,"seq":1,"cpu":87,"cores":4,"mem":[8388608,2097152],"temp":[{"t":"acpitz","c":63000}]}`
    )
    await chmod(cli, 0o755)
    const updates: StatusItem[] = []
    const host = mockHost({
      settings: { source: 'remote', targetWorkspace: 'id:abc::/home/me/site', orcaCli: cli },
      results: {
        'statusBar.update': (params: StatusItem) => {
          updates.push(params)
          return { ok: true }
        }
      }
    })
    const worker = await mountWorker(main, { host })
    let calls = ''
    try {
      await waitsUntil(() => updates.some((item) => item.text.startsWith('site · CPU')))
      const shown = updates.find((item) => item.text.startsWith('site · CPU'))
      assert.equal(shown?.text, 'site · CPU 9% · RAM 2.0/8.0G · 63°C')
      assert.equal(shown?.tooltip, 'site (this computer) · CPU 8.7% (4 threads) · RAM 2.0/8.0 GiB (25%) · acpitz 63°')
      assert.deepEqual(worker.refusals, [])
      assert.deepEqual(worker.logs, [])
    } finally {
      await worker.deactivate()
      calls = await readFile(join(dir, 'calls'), 'utf8')
      await rm(dir, { recursive: true, force: true })
    }
    // One terminal opened, read until a reading came, and closed when the worker stopped.
    assert.equal(calls, 'worktree show\nterminal list\nterminal create\nterminal read\nterminal close\n')
  })
}

/** Lets what a just-resolved promise started run to its end. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}
