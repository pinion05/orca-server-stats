// The poll, the sampling behind it, and the worker as Orca starts it. Timers and readings are the
// test's own, so nothing here waits on a real interval or needs a real sensor.

import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, assert, beforeEach, hostError, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { createCollector } from './collector'
import { CONFIG_FILE_ENV } from './config-file'
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
import type { JsonValue } from 'orca/worker'
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

/** An environment variable as it was, to be put back. */
const HOME = process.env.HOME
const NAMED = process.env[CONFIG_FILE_ENV]
/** A folder of the test's own, and the config file the worker is told to read in it. */
let folder = ''
let configFile = ''

/**
 * The worker reads a config file from wherever its environment says, so every test here names one
 * in a folder of its own: nothing from the home folder of whoever runs the tests reaches it. The
 * home folder is pointed there too, for the test that leaves the variable out.
 */
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'server-stats-worker-'))
  configFile = join(folder, 'config.json')
  process.env[CONFIG_FILE_ENV] = configFile
  process.env.HOME = join(folder, 'home')
})

afterEach(async () => {
  if (NAMED === undefined) {
    delete process.env[CONFIG_FILE_ENV]
  } else {
    process.env[CONFIG_FILE_ENV] = NAMED
  }
  if (HOME === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = HOME
  }
  await rm(folder, { recursive: true, force: true })
})

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
      targetWorkspace: 'id:11111111-1111-1111-1111-111111111111::/nowhere',
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

/** What the Settings screen can hold, and so what a config file can hold once parsed. */
type Settings = Record<string, JsonValue>

/** The config file of the test, where the worker is told to look for one, holding these settings. */
const writeConfig = (settings: Settings): Promise<void> => writeFile(configFile, JSON.stringify(settings))

/** A workspace selector that is no workspace's, so that the item names it by its folder, `nowhere`. */
const NOWHERE = 'id:11111111-1111-1111-1111-111111111111::/nowhere'
/** What the item then says of why there is no reading, with no Orca CLI to reach it. */
const NOT_FOUND = 'Orca CLI not found (see the Orca CLI setting)'

/** The `orca` to reach a workspace with: one that is not there, so that no test runs a real one. */
const noCli = (): string => join(folder, 'no-such-orca-cli')

/** A config file that asks for a workspace's machine which no CLI can reach. */
const unreachable = (): Settings => ({
  source: 'remote',
  targetWorkspace: NOWHERE,
  orcaCli: noCli()
})

/**
 * Notes every item the worker sends. `next()` answers with the first one to come after it was
 * asked for, so that a test waits on a reading and not on a clock.
 */
function inbox(): { items: StatusItem[]; next(): Promise<StatusItem>; update: (item: StatusItem) => { ok: true } } {
  const items: StatusItem[] = []
  let waiting: Array<(item: StatusItem) => void> = []
  return {
    items,
    next: () =>
      new Promise<StatusItem>((resolve) => {
        waiting.push(resolve)
      }),
    update: (item) => {
      items.push(item)
      const tell = waiting
      waiting = []
      for (const resolve of tell) {
        resolve(item)
      }
      return { ok: true }
    }
  }
}

/** The worker over a host whose settings are `settings`, with every item it sends noted. */
async function started(settings: Settings = {}): Promise<ReturnType<typeof inbox> & { worker: TestWorker }> {
  const box = inbox()
  const worker = await mountWorker(main, { host: mockHost({ settings, results: { 'statusBar.update': box.update } }) })
  return { ...box, worker }
}

/** What the tooltip ends with while a config file is in use, with the separator before it. */
const IN_USE = ' · config file'

test('without a config file the settings are used as they are, and nothing speaks of one', async () => {
  // The variable names a file that is not there, which comes to the same as no variable.
  const { next, worker } = await started()
  try {
    const item = await Promise.race([next(), givesUp()])
    assert.ok(item.text.startsWith('CPU '))
    assert.ok(!item.tooltip.includes('config file'))
    assert.ok(!item.tooltip.includes('unavailable'))
    assert.deepEqual(worker.logs, [])
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

test('a config file comes before the settings, key by key, and the tooltip ends by saying it is in use', async () => {
  await writeConfig({ source: 'remote', targetWorkspace: NOWHERE })
  // The file leaves the CLI to the settings, which name one. Their source, this computer's, gives way to the file's.
  const { next, worker } = await started({ orcaCli: noCli(), refreshSeconds: 3 })
  try {
    const item = await Promise.race([next(), givesUp()])
    assert.equal(item.text, 'nowhere · No host stats')
    assert.equal(item.tooltip, `nowhere (this computer) · unavailable: ${NOT_FOUND}${IN_USE}`)
    assert.ok(worker.logs.every((line) => !line.includes('config file')))
  } finally {
    await worker.deactivate()
  }
})

test('where the file gives a setting, the settings give way', async () => {
  // The settings ask for a workspace's machine that cannot be reached; the file asks for this computer.
  await writeConfig({ source: 'local', refreshSeconds: 1 })
  const { next, worker } = await started(unreachable())
  try {
    const item = await Promise.race([next(), givesUp()])
    assert.ok(item.text.startsWith('CPU '))
    assert.ok(item.tooltip.endsWith(IN_USE))
    assert.ok(!item.tooltip.includes('unavailable'))
    // No terminal was ever tried, so nothing was logged.
    assert.deepEqual(worker.logs, [])
  } finally {
    await worker.deactivate()
  }
})

test('the file is the one the environment variable names, and else the one in the home folder', async () => {
  // Somewhere else altogether, under another name.
  const elsewhere = join(folder, 'elsewhere.json')
  process.env[CONFIG_FILE_ENV] = elsewhere
  await writeFile(elsewhere, JSON.stringify(unreachable()))
  // Where the worker would look otherwise, saying the opposite.
  await writeConfig({ source: 'local' })
  const named = await started()
  try {
    const item = await Promise.race([named.next(), givesUp()])
    assert.equal(item.text, 'nowhere · No host stats')
    assert.ok(item.tooltip.endsWith(IN_USE))
  } finally {
    await named.worker.deactivate()
  }
  if (process.platform === 'win32') {
    // The home folder is found another way there.
    return
  }
  // With no variable, the file in the home folder is the one; the one beside the first is not.
  delete process.env[CONFIG_FILE_ENV]
  const inHome = join(process.env.HOME as string, '.config', 'orca-server-stats', 'config.json')
  await mkdir(dirname(inHome), { recursive: true })
  await writeFile(inHome, JSON.stringify(unreachable()))
  const byDefault = await started()
  try {
    const item = await Promise.race([byDefault.next(), givesUp()])
    assert.equal(item.text, 'nowhere · No host stats')
    assert.ok(item.tooltip.endsWith(IN_USE))
  } finally {
    await byDefault.worker.deactivate()
  }
})

test('the file is read before every reading: a change applies from the next one on, and deleting it gives the settings back', async () => {
  await writeConfig(unreachable())
  // A minute between readings, where the settings have a say.
  const { next, worker } = await started({ refreshSeconds: 60 })
  try {
    const first = await Promise.race([next(), givesUp()])
    assert.equal(first.text, 'nowhere · No host stats')
    assert.ok(first.tooltip.endsWith(IN_USE))
    // Now this computer, every second.
    await writeConfig({ source: 'local', refreshSeconds: 1 })
    const changed = await Promise.race([next(), givesUp()])
    assert.ok(changed.text.startsWith('CPU '))
    assert.ok(changed.tooltip.endsWith(IN_USE))
    assert.ok(!changed.tooltip.includes('unavailable'))
    // Deleted. The reading that follows comes a second later, so it is the file's interval that was
    // in use, and from it on the settings are used alone: nothing speaks of a file any more.
    await unlink(configFile)
    const deleted = await Promise.race([next(), givesUp()])
    assert.ok(deleted.text.startsWith('CPU '))
    assert.ok(!deleted.tooltip.includes('config file'))
    assert.ok(!deleted.tooltip.includes('unavailable'))
    assert.ok(worker.logs.every((line) => !line.includes('config file')))
  } finally {
    await worker.deactivate()
  }
})

test('a file that is not JSON is left wholly to the settings, said in the tooltip, and logged once', async () => {
  await writeFile(configFile, '{oops')
  const { next, worker } = await started({ refreshSeconds: 1 })
  const once = [`config file ${configFile}: invalid JSON; the Settings values are used instead`]
  try {
    const first = await Promise.race([next(), givesUp()])
    assert.ok(first.text.startsWith('CPU '))
    assert.ok(first.tooltip.includes('unavailable: config file: invalid JSON'))
    assert.ok(!first.tooltip.endsWith(IN_USE))
    assert.deepEqual(worker.logs, once)
    // Readings go on, and each reads the same broken file: the log says no more.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    assert.deepEqual(worker.logs, once)
    assert.deepEqual(worker.refusals, [])
    // Another fault is said too, once, when it comes.
    await writeConfig({ refreshSeconds: '5' })
    const second = await Promise.race([next(), givesUp()])
    assert.ok(second.tooltip.includes('unavailable: config file: invalid refreshSeconds'))
    assert.ok(!second.tooltip.endsWith(IN_USE))
    // The Settings value is used for it, and the log says which.
    const again = `config file ${configFile}: refreshSeconds is not a whole number from 1 to 60; the Settings value is used for each`
    assert.deepEqual(worker.logs, [...once, again])
  } finally {
    await worker.deactivate()
  }
})

test('a value the Settings screen would not take is left to it and named, while the rest of the file is used', async () => {
  await writeConfig({ ...unreachable(), environment: 7, refreshSeconds: '5' })
  const { next, worker } = await started()
  const configLines = (): string[] => worker.logs.filter((line) => line.startsWith('config file '))
  try {
    const item = await Promise.race([next(), givesUp()])
    assert.equal(item.text, 'nowhere · No host stats')
    assert.equal(item.tooltip, `nowhere (this computer) · unavailable: config file: invalid environment +1 more, ${NOT_FOUND}${IN_USE}`)
    // The Settings value is used for it, and the log says which.
    const faults = 'environment is not text of at most 128 characters, refreshSeconds is not a whole number from 1 to 60'
    assert.deepEqual(configLines(), [`config file ${configFile}: ${faults}; the Settings value is used for each`])
    // Later readings say other things, of the CLI that is not there; the file is not spoken of again.
    await waitsUntil(() => worker.logs.filter((line) => line.startsWith('remote: ')).length >= 2)
    assert.equal(configLines().length, 1)
  } finally {
    await worker.deactivate()
  }
})

test('a file that asks for a workspace\'s machine without naming the workspace says what is missing, and that it is in use', async () => {
  await writeConfig({ source: 'remote', refreshSeconds: 'soon' })
  const { next, worker } = await started()
  try {
    const item = await Promise.race([next(), givesUp()])
    assert.equal(item.text, 'No host stats')
    assert.equal(item.tooltip, `unavailable: config file: invalid refreshSeconds, set the workspace to measure (targetWorkspace)${IN_USE}`)
    assert.equal(worker.logs.length, 1)
  } finally {
    await worker.deactivate()
  }
})

/**
 * A stand-in for the Orca CLI, run as the real one is: it notes its calls in `<dir>/calls`, each
 * followed by the server it was asked to reach where there was one, opens one terminal, and has
 * the stats script's line in it. It answers `cli`, the command to run.
 */
async function standIn(dir: string): Promise<string> {
  const cli = join(dir, 'orca')
  await writeFile(
    cli,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const args = process.argv.slice(2)',
      'const server = process.env.ORCA_ENVIRONMENT',
      `fs.appendFileSync('${join(dir, 'calls')}', args.slice(0, 2).join(' ') + (server ? ' ' + server : '') + '\\n')`,
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
  return cli
}

if (process.platform !== 'win32') {
  test('for a workspace\'s machine the worker reaches it through the Orca CLI, and closes its terminal when it stops', async () => {
    // A stand-in for the Orca CLI, run as the real one is: it notes its calls, opens one terminal,
    // and has the stats script's line in it.
    const dir = await mkdtemp(join(tmpdir(), 'server-stats-orca-'))
    const cli = await standIn(dir)
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

  test('a change in the file closes the terminal in use and opens another, as a change in the settings does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'server-stats-orca-'))
    const calls = join(dir, 'calls')
    const cli = await standIn(dir)
    const measured = { source: 'remote', targetWorkspace: 'id:abc::/home/me/site', orcaCli: cli, refreshSeconds: 3 }
    await writeConfig(measured)
    let lines: string[] = []
    try {
      const { items, worker } = await started()
      try {
        // One terminal, opened and read until a reading came out of it.
        await waitsUntil(() => items.some((item) => item.text.startsWith('site · CPU')))
        // Another server, set in the file. At the next reading the terminal in use is closed, and
        // one is opened on that server.
        await writeConfig({ ...measured, environment: 'my-server' })
        await waitsUntil(() => items.some((item) => item.tooltip.startsWith('site on my-server ·')))
        assert.ok(worker.logs.every((line) => !line.includes('config file')))
      } finally {
        await worker.deactivate()
      }
      // The terminal let go is closed by a process of its own, which may be a moment behind
      // the worker.
      await waitsFor(async () => (await readFile(calls, 'utf8')).includes('terminal close\n'))
      lines = (await readFile(calls, 'utf8')).trim().split('\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    // This computer's terminal: opened once, read, closed once, and never opened again.
    const own = lines.filter((line) => !line.endsWith(' my-server'))
    const reads = own.filter((line) => line === 'terminal read').length
    assert.ok(reads >= 1)
    assert.deepEqual(own, ['worktree show', 'terminal list', 'terminal create', ...Array<string>(reads).fill('terminal read'), 'terminal close'])
    // The paired server's: opened for the file's new server, and closed when the worker stopped.
    const paired = lines.filter((line) => line.endsWith(' my-server'))
    assert.deepEqual(paired.slice(0, 3), ['worktree show my-server', 'terminal list my-server', 'terminal create my-server'])
    assert.equal(paired.at(-1), 'terminal close my-server')
    assert.ok(paired.slice(3, -1).every((line) => line === 'terminal read my-server'))
  })
}

/** As `waitsUntil`, for what can only be known by asking; fails the test if it never holds. */
async function waitsFor(ready: () => Promise<boolean>): Promise<void> {
  for (let waited = 0; !(await ready()) && waited < 8_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(await ready(), 'it never came')
}

/** Lets what a just-resolved promise started run to its end. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}
