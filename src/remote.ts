// The remote mode: one terminal left open on the measured machine, running the stats script, and
// read through the Orca CLI. The terminal is opened again when it is lost, after a wait that grows
// with each failure, and closed when the plugin stops. Nothing here rejects: what failed is said in
// the reading's `problems`, and the item keeps its last good numbers for a while.

import {
  cleanText,
  ORIGIN_BAR_MAX,
  ORIGIN_TOOLTIP_MAX,
  type MetricsSnapshot,
  type Origin
} from './metrics'
import { describeError, logOnce } from './log'
import {
  createOrcaCli,
  describeCliFailure,
  type CliFailure,
  type CliOutcome,
  type OrcaCli
} from './orca-cli'
import { STATS_TITLE, statsCommand } from './stats-command'
import { parseStatsLines, statsLineToSnapshot } from './stats-line'

/** Lines of the terminal asked for per reading: the newest whole line is among them. */
const READ_LINES = 6
const CREATE_TIMEOUT_MS = 15_000
/** The script prints its first line about a second after it starts; until it does, look again soon. */
const FIRST_READING_WAIT_MS = 1_500
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000
const STALE_AFTER_MS = 15_000
/** How long the last good reading stays on the bar while the terminal is being reopened. */
const KEEP_LAST_READING_MS = 120_000
/** `close` waits this long for a terminal that is being opened, then ends the CLI calls. */
const CLOSE_WAIT_MS = 6_000
/** Closing a terminal is quick when the CLI answers, and not worth waiting longer for when it does not. */
const CLOSE_TIMEOUT_MS = 4_000
const NAME_MAX = 32

export type RemoteConfig = {
  /** The paired Orca server, as `orca environment list --json` names it; empty for this computer's own. */
  environment: string
  /** The workspace whose machine is measured, as the Orca CLI takes a worktree selector. */
  targetWorkspace: string
  /** The `orca` command to run. */
  orcaCli: string
  /** Seconds between readings. */
  refreshSeconds: number
}

export type RemoteReading = {
  snapshot: MetricsSnapshot
  /** When the next reading is worth having sooner than the interval. */
  retryInMs?: number
}

export type RemoteSource = {
  /** One reading. Never rejects. */
  read(): Promise<RemoteReading>
  /** Closes the terminal and ends the CLI calls. Never rejects, and never takes long. */
  close(): Promise<void>
}

export type RemoteSourceOptions = {
  config: RemoteConfig
  /** The CLI to run; the real one is started from the config. */
  cli?: OrcaCli
  now?: () => number
  log?: (message: string) => void
  /** How long `close` waits for a terminal that is still being opened. The default is six seconds. */
  closeWaitMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The workspace as the item can name it, before the CLI has told its display name. */
export function fallbackWorkspaceName(selector: string): string {
  const path = selector.replace(/^id:[^:]*::/, '').replace(/^identity:/, '').replace(/\/+$/, '')
  return cleanText(path.slice(path.lastIndexOf('/') + 1), NAME_MAX) || cleanText(selector, NAME_MAX)
}

export function createRemoteSource(options: RemoteSourceOptions): RemoteSource {
  const { config } = options
  const now = options.now ?? ((): number => performance.now())
  const cli = options.cli ?? createOrcaCli({ command: config.orcaCli, environment: config.environment })
  const log = logOnce(options.log ?? ((): void => undefined))

  let handle: string | null = null
  let openedAt = 0
  /** The sample number last seen, so a line read twice is not taken for a new one. */
  let lastSeq: number | null = null
  let lastNewAt = 0
  let last: MetricsSnapshot | null = null
  let lastAt = 0
  let failures = 0
  let retryAt = 0
  let problem: string | null = null
  let workspaceName: string | null = null
  let busy = false
  let pending: Promise<void> | null = null
  let closing = false

  const backoff = (): number =>
    Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(Math.max(failures - 1, 0), 6))
  const stallAfter = (): number => Math.max(STALE_AFTER_MS, 3 * config.refreshSeconds * 1000)

  const origin = (): Origin => {
    const server = cleanText(config.environment, 24)
    const name = workspaceName ?? fallbackWorkspaceName(config.targetWorkspace)
    return {
      bar: cleanText(server !== '' ? server : name, ORIGIN_BAR_MAX) || 'remote',
      tooltip: cleanText(server !== '' ? `${name} on ${server}` : `${name} (this computer)`, ORIGIN_TOOLTIP_MAX)
    }
  }

  /** Gives up the terminal, if any, and waits before trying again; says why. Nothing is said while closing. */
  const lose = (failure: CliFailure): void => {
    handle = null
    if (closing) {
      return
    }
    failures += 1
    retryAt = now() + backoff()
    problem = describeCliFailure(failure)
    // The log says more than the tooltip can: what the CLI itself answered, where it answered something.
    const said = cleanText(failure.message, 160)
    const reason = said === '' || said === failure.code ? problem : said
    log(`remote: ${reason}; opening the stats terminal again in ${Math.round(backoff() / 1000)} s`)
  }

  const resolveName = async (): Promise<void> => {
    const shown = await cli(['worktree', 'show', '--worktree', config.targetWorkspace])
    const name =
      shown.ok && isRecord(shown.result) && isRecord(shown.result.worktree)
        ? shown.result.worktree.displayName
        : null
    if (typeof name === 'string') {
      workspaceName = cleanText(name, NAME_MAX) || null
    }
  }

  /**
   * Closes what an earlier run left with the plugin's title, so there is never more than one such
   * terminal, then opens a new one. A worker that ended without closing leaves one behind.
   */
  const connect = async (): Promise<void> => {
    if (workspaceName === null) {
      await resolveName().catch(() => undefined)
    }
    const listed = await cli(['terminal', 'list', '--worktree', config.targetWorkspace])
    if (!listed.ok) {
      return lose(listed)
    }
    const terminals = isRecord(listed.result) && Array.isArray(listed.result.terminals) ? listed.result.terminals : []
    for (const terminal of terminals) {
      if (isRecord(terminal) && terminal.title === STATS_TITLE && typeof terminal.handle === 'string') {
        await cli(['terminal', 'close', '--terminal', terminal.handle])
      }
    }
    const created = await cli(
      [
        'terminal',
        'create',
        '--worktree',
        config.targetWorkspace,
        '--title',
        STATS_TITLE,
        '--command',
        statsCommand({ refreshSeconds: config.refreshSeconds })
      ],
      { timeoutMs: CREATE_TIMEOUT_MS }
    )
    if (!created.ok) {
      return lose(created)
    }
    const createdHandle =
      isRecord(created.result) && isRecord(created.result.terminal) ? created.result.terminal.handle : null
    if (typeof createdHandle !== 'string' || createdHandle === '') {
      return lose({ ok: false, code: 'no_handle', message: 'the Orca CLI gave no terminal handle' })
    }
    if (closing) {
      // Stopped while the terminal was being opened: it is closed at once and not kept.
      await cli(['terminal', 'close', '--terminal', createdHandle])
      return
    }
    handle = createdHandle
    openedAt = now()
    lastSeq = null
    problem = null
    log.reset()
  }

  const readTerminal = async (): Promise<void> => {
    const outcome = await cli(['terminal', 'read', '--terminal', handle as string, '--limit', String(READ_LINES)])
    if (!outcome.ok) {
      return lose(outcome)
    }
    const terminal = isRecord(outcome.result) && isRecord(outcome.result.terminal) ? outcome.result.terminal : {}
    if (terminal.status === 'exited') {
      return lose({ ok: false, code: 'exited', message: 'the stats terminal exited' })
    }
    const tail: unknown = terminal.tail
    // Lines, as the CLI gives them; a terminal's output as one text, should a version give that.
    const lines: string[] =
      typeof tail === 'string'
        ? tail.split('\n')
        : Array.isArray(tail)
          ? tail.filter((line): line is string => typeof line === 'string')
          : []
    const line = parseStatsLines(lines)
    if (line && (lastSeq === null || line.seq > lastSeq)) {
      lastSeq = line.seq
      last = statsLineToSnapshot(line, origin())
      lastAt = now()
      lastNewAt = lastAt
      failures = 0
      problem = null
      log.reset()
    } else if (now() - Math.max(lastNewAt, openedAt) > stallAfter()) {
      return lose({ ok: false, code: 'stalled', message: `no new reading for ${Math.round(stallAfter() / 1000)} s` })
    }
  }

  /** What the item shows now: the last good reading while it is recent, else the reason there is none. */
  const current = (retryInMs?: number): RemoteReading => {
    if (last && now() - lastAt <= KEEP_LAST_READING_MS) {
      const problems = problem ? [...new Set([...last.problems, problem])] : [...last.problems]
      return { snapshot: problems.length === last.problems.length ? last : { ...last, problems }, retryInMs }
    }
    return {
      snapshot: {
        cpu: null,
        memory: null,
        temperatures: [],
        gpu: null,
        cpuModel: null,
        load: null,
        uptimeSeconds: null,
        problems: [problem ?? 'waiting for the first reading'],
        origin: origin()
      },
      retryInMs
    }
  }

  /** When the next reading is worth having at a set moment: a terminal waited for, or one without a first line. */
  const hint = (): number | undefined => {
    if (handle === null) {
      return retryAt > now() ? retryAt - now() : undefined
    }
    // The script needs a moment for its first line; until one arrives, look again soon.
    return lastSeq === null ? FIRST_READING_WAIT_MS : undefined
  }

  const work = async (): Promise<RemoteReading> => {
    if (closing) {
      return current()
    }
    if (handle === null) {
      if (now() < retryAt) {
        return current(retryAt - now())
      }
      await connect()
    } else {
      await readTerminal()
    }
    return current(hint())
  }

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  return {
    async read(): Promise<RemoteReading> {
      // One call at a time: a tick that finds one in flight shows what the last one found.
      if (busy) {
        return current()
      }
      busy = true
      const run = (async (): Promise<RemoteReading> => {
        try {
          return await work()
        } catch (error) {
          lose({ ok: false, code: 'error', message: describeError(error) })
          return current(hint())
        }
      })()
      pending = run.then(
        () => undefined,
        () => undefined
      )
      try {
        return await run
      } finally {
        pending = null
        busy = false
      }
    },

    async close(): Promise<void> {
      closing = true
      // A terminal that is still being opened is waited for, so that it can be closed by its handle.
      if (pending && handle === null) {
        await Promise.race([pending, wait(options.closeWaitMs ?? CLOSE_WAIT_MS)])
      }
      const open = handle
      handle = null
      if (open !== null) {
        await cli(['terminal', 'close', '--terminal', open], { timeoutMs: CLOSE_TIMEOUT_MS }).catch(() => undefined)
      }
      cli.stop()
    }
  }
}
