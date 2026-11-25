// The plugin's worker: reads a machine every refresh interval and writes one status bar item.
// The machine is this one, or the one hosting a workspace on a paired Orca server. Orca starts
// the worker when the plugin is enabled and keeps it running while it stays enabled, which is
// what lets it poll without an event. Nothing here may throw or leave a rejection behind: an
// escaped error ends the worker, and one that fails to activate stays down until the plugin
// changes. A step that fails at start is logged and tried again on the next reading.

import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import { createCollector, type Collector } from './collector'
import { describeError, logOnce } from './log'
import {
  createTooltipSelector,
  emptySnapshot,
  statusItemFor,
  type MetricsSnapshot,
  type StatusItem,
  type TooltipSelector
} from './metrics'
import { createRemoteSource, type RemoteSource } from './remote'
import { createSystemReader } from './system'

/** The `id` of the item in `contributes.statusBarItems`. */
export const ITEM_ID = 'resources'
/** The keys in `contributes.settings`. */
export const SOURCE_SETTING = 'source'
export const ENVIRONMENT_SETTING = 'environment'
export const WORKSPACE_SETTING = 'targetWorkspace'
export const CLI_SETTING = 'orcaCli'
export const REFRESH_SETTING = 'refreshSeconds'
export const DEFAULT_REFRESH_SECONDS = 2
/** A workspace's machine is read this often unless the person sets 3 seconds or more. */
export const REMOTE_REFRESH_SECONDS = 5
export const DEFAULT_ORCA_CLI = 'orca'
const MIN_REFRESH_SECONDS = 1
const MAX_REFRESH_SECONDS = 60
/** A read that overran its interval still waits this long, so a slow host never spins. */
const MIN_DELAY_MS = 250
/** No tick holds the loop longer than this: what has not arrived is left to the next one. */
const TICK_LIMIT_MS = 15_000
/** After this many failed updates in a row, read slowly until one gets through. */
const STRUGGLING_AFTER = 3
const STRUGGLING_DELAY_MS = 10_000

/** The settings as the worker uses them. */
export type PluginConfig = {
  /** A workspace's machine on a paired Orca server, rather than this one. */
  remote: boolean
  /** The paired Orca server, as `orca environment list --json` names it; empty for this computer's own. */
  environment: string
  /** The workspace whose machine is measured, as the Orca CLI takes a worktree selector. */
  targetWorkspace: string
  /** The `orca` command to run for it. */
  orcaCli: string
  /** What the person set, 1 to 60 seconds. */
  refreshSeconds: number
}

function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** A settings value as a number of seconds, within what the manifest allows; 2 when it is not one. */
export function refreshSecondsOf(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) {
    return DEFAULT_REFRESH_SECONDS
  }
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(parsed)))
}

/**
 * Seconds between readings of a workspace's machine. Each one starts an Orca CLI process, so it
 * is 5 unless the person asked for 3 to 60: 1 is below what that allows, and 2 is the setting's
 * default, left as it came.
 */
export function remoteRefreshSecondsOf(seconds: number): number {
  return seconds <= DEFAULT_REFRESH_SECONDS ? REMOTE_REFRESH_SECONDS : seconds
}

export function intervalSecondsOf(config: PluginConfig): number {
  return config.remote ? remoteRefreshSecondsOf(config.refreshSeconds) : config.refreshSeconds
}

export function configOf(settings: Record<string, unknown>): PluginConfig {
  return {
    remote: settings[SOURCE_SETTING] === 'remote',
    environment: textOf(settings[ENVIRONMENT_SETTING], ''),
    targetWorkspace: textOf(settings[WORKSPACE_SETTING], ''),
    orcaCli: textOf(settings[CLI_SETTING], DEFAULT_ORCA_CLI),
    refreshSeconds: refreshSecondsOf(settings[REFRESH_SETTING])
  }
}

/** Identifies what a remote source reads and how often: a change means a new terminal. */
export function remoteKeyOf(config: PluginConfig): string {
  return [config.environment, config.targetWorkspace, config.orcaCli, intervalSecondsOf(config)].join('\u0000')
}

/** Timers, behind an interface so tests can fire them by hand. */
export type Scheduler = {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

const systemScheduler: Scheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0])
}

export type Reading = {
  snapshot: MetricsSnapshot
  /** When the source knows the next reading is worth having sooner than the interval. */
  retryInMs?: number
}

export type LoopOptions = {
  /** One reading; it never rejects, and what it could not read says so in the snapshot. */
  sample: () => Promise<Reading>
  /** Sends an item to the status bar; rejects when Orca refuses or cannot show it. */
  publish: (item: StatusItem) => Promise<unknown>
  /** The item for a reading; a selector made by `createTooltipSelector` keeps its level steady. */
  render?: (snapshot: MetricsSnapshot) => StatusItem
  /** The interval now, so a changed setting applies from the next tick on. */
  intervalMs: () => number
  /** The item's id in the manifest, for the default `render`. */
  itemId?: string
  log: (message: string) => void
  scheduler?: Scheduler
  now?: () => number
  tickLimitMs?: number
}

export type Loop = {
  /** Schedules the first tick at once. */
  start(): void
  /** Runs a tick now, or joins the one in flight, and resolves when it has ended. */
  run(): Promise<void>
  /** Brings the next tick forward to now. */
  kick(): void
  /** Cancels the next tick; a tick in flight ends without publishing. */
  stop(): void
  /** Logs a message, once while the same one keeps repeating. */
  log(message: string): void
}

/** How long a `rate_limited` refusal asks to wait; 0 for anything else. */
function retryDelay(error: unknown): number {
  const ms = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
}

type TickResult = {
  limited: boolean
  /** How long a `rate_limited` refusal asked to wait; 0 when it did not. */
  waitForMs: number
  /** When the source says the next reading is worth having sooner. */
  retryInMs: number | undefined
}

/**
 * The poll: sample, publish what changed, then wait the rest of the interval. One tick at a time,
 * whatever the timer does, and none longer than its limit: when a reading has not come back by
 * then the next tick is scheduled all the same. A reading that comes late still updates the item
 * while no newer one has begun: it is newer than what is shown, and from a source that is always
 * slow it is the only way its reason reaches the status bar. A failing read or update is logged
 * once and the loop goes on.
 */
export function startLoop(options: LoopOptions): Loop {
  const scheduler = options.scheduler ?? systemScheduler
  // The monotonic clock, since the wall clock can jump in the middle of an interval.
  const now = options.now ?? ((): number => performance.now())
  const render =
    options.render ??
    ((snapshot: MetricsSnapshot): StatusItem => statusItemFor(snapshot, options.itemId ?? ITEM_ID))
  const tickLimitMs = options.tickLimitMs ?? TICK_LIMIT_MS
  let timer: unknown = null
  let limitTimer: unknown = null
  let inFlight: Promise<void> | null = null
  /** The newest tick begun. Only it may publish: a reading left behind by its limit is shown only until then. */
  let current = 0
  let stopped = true
  let failures = 0
  /** The last item Orca accepted, so an unchanged one is not sent again. */
  let lastSent = ''
  const log = logOnce(options.log)

  const clearTimer = (): void => {
    if (timer === null) {
      return
    }
    const handle = timer
    timer = null
    try {
      scheduler.clear(handle)
    } catch {
      // Already gone.
    }
  }

  const clearLimitTimer = (): void => {
    if (limitTimer === null) {
      return
    }
    const handle = limitTimer
    limitTimer = null
    try {
      scheduler.clear(handle)
    } catch {
      // Already gone.
    }
  }

  const schedule = (delayMs: number): void => {
    if (stopped) {
      return
    }
    try {
      timer = scheduler.set(() => {
        timer = null
        void run()
      }, delayMs)
    } catch (error) {
      log(`could not schedule the next reading: ${describeError(error)}`)
    }
  }

  /** Sends the item when it changed. Answers the wait a refusal asked for, 0 otherwise. */
  const publishOnce = async (item: StatusItem): Promise<number> => {
    try {
      const sent = JSON.stringify(item)
      if (sent !== lastSent) {
        await options.publish(item)
        lastSent = sent
      }
      failures = 0
      log.reset()
      return 0
    } catch (error) {
      failures += 1
      log(`status bar update failed: ${describeError(error)}`)
      return retryDelay(error)
    }
  }

  /** One tick: a reading, and the item for it while it is still this tick's to publish. */
  const tick = async (serial: number, startedAt: number): Promise<TickResult> => {
    const result: TickResult = { limited: false, waitForMs: 0, retryInMs: undefined }
    try {
      const reading = await options.sample()
      result.retryInMs = reading.retryInMs
      if (!stopped && serial === current) {
        result.waitForMs = await publishOnce(render(reading.snapshot))
      }
    } catch (error) {
      // Nothing above should throw; if something does, say so and carry on.
      failures += 1
      log(`update failed: ${describeError(error)}`)
    }
    return result
  }

  /** When the next tick is due: the rest of the interval, as a rate limit asks, or sooner when it is worth it. */
  const delayFor = (result: TickResult, startedAt: number): number => {
    const interval = options.intervalMs()
    // One that ran out of its limit waits a whole interval, so a stuck source is not asked again at once.
    let delay = result.limited ? interval : Math.max(MIN_DELAY_MS, interval - (now() - startedAt))
    if (result.retryInMs !== undefined) {
      delay = Math.max(MIN_DELAY_MS, Math.min(delay, result.retryInMs))
    }
    // What Orca asked for comes first: a source may want the next reading soon, and still have to wait.
    if (result.waitForMs > 0) {
      delay = Math.max(delay, result.waitForMs)
    }
    return Math.max(delay, failures >= STRUGGLING_AFTER ? STRUGGLING_DELAY_MS : 0)
  }

  const run = (): Promise<void> => {
    if (inFlight) {
      return inFlight
    }
    clearTimer()
    const startedAt = now()
    const serial = ++current
    const abandoned: TickResult = { limited: true, waitForMs: 0, retryInMs: undefined }
    const limit = new Promise<TickResult>((resolve) => {
      limitTimer = scheduler.set(() => {
        limitTimer = null
        resolve(abandoned)
      }, tickLimitMs)
    })
    const work = tick(serial, startedAt)
    inFlight = Promise.race([work, limit]).then(
      (result) => {
        clearLimitTimer()
        if (result.limited) {
          failures += 1
          log(`a reading took longer than ${Math.round(tickLimitMs / 1000)} s; the next one follows`)
        }
        inFlight = null
        if (!stopped) {
          schedule(delayFor(result, startedAt))
        }
      },
      () => {
        clearLimitTimer()
        inFlight = null
      }
    )
    return inFlight
  }

  return {
    start() {
      if (stopped) {
        stopped = false
        schedule(0)
      }
    },
    run,
    kick() {
      if (stopped || inFlight) {
        return
      }
      clearTimer()
      schedule(0)
    },
    stop() {
      stopped = true
      clearTimer()
    },
    log
  }
}

let stop: (() => void | Promise<void>) | null = null

/** Orca awaits this before it stops the worker. It closes the terminal the remote mode opened. */
export async function deactivate(): Promise<void> {
  const done = stop
  stop = null
  try {
    await done?.()
  } catch {
    // Nothing is left to tell: the worker is on its way out.
  }
}

/**
 * Starts reading and updating. Whatever fails here is caught and logged, and whatever needs the
 * settings is done again on the next reading, so a bad start is a late first reading and not a
 * worker that never came up.
 */
function start(orca: OrcaWorkerApi): () => Promise<void> {
  const log = logOnce((message: string) => orca.log(message))
  const tooltip: TooltipSelector = createTooltipSelector()
  const collector: Collector = createCollector({ reader: createSystemReader() })
  let config: PluginConfig = configOf({})
  let settingsRead = false
  let remote: RemoteSource | null = null
  let remoteKey = ''
  let subscription: Disposable | null = null

  /** Closes the terminal of the source that was in use; that is not waited for. */
  const releaseRemote = (): void => {
    const old = remote
    remote = null
    if (old) {
      void old.close().catch(() => undefined)
    }
  }

  /** Follows the settings into local or remote mode, and to a new terminal when the target or the interval changed. */
  const applySettings = (settings: Record<string, unknown>): void => {
    config = configOf(settings)
    const key = config.remote && config.targetWorkspace !== '' ? remoteKeyOf(config) : ''
    if (key === remoteKey) {
      return
    }
    remoteKey = key
    releaseRemote()
    tooltip.reset?.()
    if (key !== '') {
      remote = createRemoteSource({
        config: {
          environment: config.environment,
          targetWorkspace: config.targetWorkspace,
          orcaCli: config.orcaCli,
          refreshSeconds: intervalSecondsOf(config)
        },
        log
      })
    }
  }

  /** Reads the settings once; when that fails it is tried again on the next reading. */
  const readSettings = async (): Promise<void> => {
    if (settingsRead) {
      return
    }
    try {
      applySettings((await orca.settings.get()) as Record<string, unknown>)
      settingsRead = true
    } catch (error) {
      log(`could not read the settings, using the defaults: ${describeError(error)}`)
    }
  }

  const sample = async (): Promise<Reading> => {
    listen()
    await readSettings()
    if (remote) {
      return remote.read()
    }
    if (config.remote) {
      return { snapshot: emptySnapshot(['set the workspace to measure (targetWorkspace)']) }
    }
    return { snapshot: await collector.sample() }
  }

  const loop = startLoop({
    sample,
    publish: (item) => orca.host.call('statusBar.update', item),
    render: (snapshot) => statusItemFor(snapshot, ITEM_ID, tooltip),
    intervalMs: () => intervalSecondsOf(config) * 1000,
    log
  })

  /** Hears setting changes from here on. Where Orca is not ready for that at start, every reading tries again. */
  const listen = (): void => {
    if (subscription !== null) {
      return
    }
    try {
      subscription = orca.settings.onDidChange(() => {
        // A setting changed in Orca's Settings is read on the next tick, which follows at once.
        settingsRead = false
        loop.kick()
      })
    } catch (error) {
      log(`could not listen for setting changes: ${describeError(error)}`)
    }
  }

  loop.start()
  listen()
  return async () => {
    loop.stop()
    subscription?.dispose()
    const old = remote
    remote = null
    if (old) {
      await old.close()
    }
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  const previous = stop
  stop = null
  // The loop of an earlier start in this worker stops at once; its terminal closes when it can.
  try {
    void Promise.resolve(previous?.()).catch(() => undefined)
  } catch {
    // A stop that fails changes nothing: that loop was already told to stop.
  }
  try {
    stop = start(orca)
  } catch (error) {
    stop = null
    try {
      orca.log(`could not start: ${describeError(error)}`)
    } catch {
      // Nothing can be told.
    }
  }
}
