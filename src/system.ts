// The operating system side: the files and commands behind ./metrics.ts. Linux is read through
// /proc and /sys; macOS and Windows get what Node reports about them. A metric that cannot be read
// is left out with a reason, never guessed, and nothing here throws at its caller.

import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import {
  busiestGpu,
  CHIP_MAX,
  clampPercent,
  cleanText,
  CPU_MODEL_MAX,
  GPU_NAME_MAX,
  memoryUsageFrom,
  parseMeminfo,
  parseMemsize,
  parseNvidiaSmi,
  parseProcStat,
  parseTemperature,
  parseVmStat,
  SENSOR_LABEL_MAX,
  sortTemperatures,
  type CpuTimes,
  type GpuUsage,
  type MemoryUsage,
  type TemperatureReading
} from './metrics'

const NVIDIA_SMI = 'nvidia-smi'
const NVIDIA_ARGS = [
  '--query-gpu=name,utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits'
]
/** `nvidia-smi` is the one costly read, a process that wakes the card: it runs at most this often, and its last answer shows between runs. */
const NVIDIA_REFRESH_MS = 30_000
/** A host without `nvidia-smi` is asked again this rarely, in case a driver appears. */
const NVIDIA_REPROBE_MS = 5 * 60_000
const COMMAND_TIMEOUT_MS = 1_500
const COMMAND_MAX_BUFFER = 64 * 1024
/** Which sensor and GPU files exist rarely changes, so the folders are listed this often, not every tick. */
const RESCAN_MS = 60_000
/** Temperatures move slowly and every sensor is a file read, so they are read this often and kept in between. */
const TEMPERATURE_REFRESH_MS = 5_000
/** A sensor that fails this many readings in a row is left alone until the next scan. */
const SENSOR_MISSES = 3

/** A reading and, when it is missing for a reason worth showing in the tooltip, that reason. */
export type Reading<T> = { value: T; problem: string | null }

/** Reads the machine the worker runs on. Every method answers, also when it cannot read. */
export type SystemReader = {
  cpuTimes(): Promise<Reading<CpuTimes | null>>
  /** `now` is in milliseconds on a monotonic clock: macOS reads its memory only now and then. */
  memory(now: number): Promise<Reading<MemoryUsage | null>>
  /** Readable sensors, hottest first. `now` is in milliseconds on a monotonic clock: which files exist is listed afresh only now and then. */
  temperatures(now: number): Promise<Reading<readonly TemperatureReading[]>>
  /** `now` is in milliseconds on a monotonic clock: some sources are read less often than others. */
  gpu(now: number): Promise<Reading<GpuUsage | null>>
}

/** Runs one command and answers its output. The real one is `execFile`; tests answer from a fixture. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>

export type SystemReaderOptions = {
  /** `/proc` and `/sys`; tests point them at a folder of fixtures. */
  procRoot?: string
  sysRoot?: string
  platform?: string
  run?: CommandRunner
}

/** Why a read failed, in a word or two: its error code where there is one. */
export function failureReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, killed } = error as { code?: unknown; killed?: unknown }
    if (killed === true) {
      return 'timed out'
    }
    if (typeof code === 'number') {
      return `exit ${code}`
    }
    if (typeof code === 'string' && code !== '') {
      return cleanText(code, 24)
    }
  }
  return 'unreadable'
}

const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout)
        }
      }
    )
  })

/** A file's text, or null when it cannot be read: missing, forbidden, or anything else. */
async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** A non-negative number as a file reports it, or null. */
function parseCount(text: string | null): number | null {
  if (text === null || text.trim() === '') {
    return null
  }
  const value = Number(text.trim())
  return Number.isFinite(value) && value >= 0 ? value : null
}

async function listEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export type CpuFacts = { cores: number | null; model: string | null }

/** Read once per worker: `os.cpus()` is a little costly to ask on every tick. */
export function cpuFacts(): CpuFacts {
  try {
    const cpus = os.cpus()
    return {
      cores: cpus.length > 0 ? cpus.length : null,
      model: cleanText(cpus[0]?.model ?? '', CPU_MODEL_MAX) || null
    }
  } catch {
    return { cores: null, model: null }
  }
}

/** Node's own CPU counters, for hosts without `/proc/stat`; null where Node reports none. */
function osCpuTimes(): CpuTimes | null {
  try {
    let total = 0
    let idle = 0
    for (const cpu of os.cpus()) {
      const { user, nice, sys, idle: waiting, irq } = cpu.times
      total += user + nice + sys + waiting + irq
      idle += waiting
    }
    return total > 0 ? { total, idle } : null
  } catch {
    return null
  }
}

/** Memory as Node reports it: right on Windows, where "free" means available. */
function osMemory(): MemoryUsage | null {
  try {
    return memoryUsageFrom(os.totalmem(), os.freemem())
  } catch {
    return null
  }
}

const MAC_MEMORY_REFRESH_MS = 5_000
const UNREADABLE_MAC_RAM: Reading<MemoryUsage | null> = {
  value: null,
  problem: 'RAM (not readable on macOS)'
}

/**
 * macOS memory, which Node does not report usefully: what it calls free is only unused pages, so
 * used would read as nearly all of it. The total comes from `sysctl` once; the used pages from
 * `vm_stat`, two commands, so no more often than every five seconds.
 */
function createMacMemoryReader(run: CommandRunner) {
  let totalBytes: number | null = null
  let last: Reading<MemoryUsage | null> = UNREADABLE_MAC_RAM
  let readAt = Number.NEGATIVE_INFINITY
  /** One command's output, or null when it could not run. */
  const ask = async (command: string, args: readonly string[]): Promise<string | null> => {
    try {
      return await run(command, args)
    } catch {
      return null
    }
  }
  return async (now: number): Promise<Reading<MemoryUsage | null>> => {
    if (totalBytes === null) {
      totalBytes = parseMemsize((await ask('/usr/sbin/sysctl', ['-n', 'hw.memsize'])) ?? '')
    }
    if (now - readAt < MAC_MEMORY_REFRESH_MS) {
      return last
    }
    readAt = now
    const stat = parseVmStat((await ask('/usr/vm_stat', [])) ?? '')
    if (totalBytes === null || !stat) {
      return last
    }
    const usedBytes = Math.min(stat.usedPages * stat.pageSize, totalBytes)
    last = { value: { usedBytes, totalBytes, percent: (usedBytes / totalBytes) * 100 }, problem: null }
    return last
  }
}

/** A `tempN_input` file, how to name it in the tooltip, and how many readings in a row it failed. */
type Sensor = { file: string; label: string; chip: string; misses: number }

const sensorNumber = (file: string): number => Number(/\d+/.exec(file)?.[0] ?? 0)
const bySensorNumber = (left: string, right: string): number => sensorNumber(left) - sensorNumber(right)

/** Hardware sensors under `/sys/class/hwmon`, which is also where `sensors` reads them. */
async function scanHwmon(base: string): Promise<Sensor[]> {
  // /sys/class entries are symlinks, never directories, so anything but a plain file may be a chip.
  const chips = await Promise.all(
    (await listEntries(base))
      .filter((entry) => !entry.isFile())
      .map(async (entry): Promise<Sensor[]> => {
        const dir = join(base, entry.name)
        const chip = cleanText((await readText(join(dir, 'name'))) || entry.name, CHIP_MAX)
        const inputs = (await readdir(dir).catch(() => [] as string[]))
          .filter((file) => /^temp\d+_input$/.test(file))
          .sort(bySensorNumber)
        return Promise.all(
          inputs.map(async (file): Promise<Sensor> => {
            const name = file.slice(0, -'_input'.length)
            const own = cleanText((await readText(join(dir, `${name}_label`))) ?? '', SENSOR_LABEL_MAX)
            // A driver that labels a sensor `temp3` has said nothing; the chip's name says more.
            const label =
              own === '' || /^temp\d+$/i.test(own) ? cleanText(`${chip} ${name}`, SENSOR_LABEL_MAX) : own
            return { file: join(dir, file), chip, label, misses: 0 }
          })
        )
      })
  )
  return distinguish(chips.flat())
}

/** ACPI thermal zones: fewer and coarser than hwmon, so only read when hwmon has nothing. */
async function scanThermalZones(base: string): Promise<Sensor[]> {
  const zones = (await listEntries(base)).filter((entry) => /^thermal_zone\d+$/.test(entry.name))
  return Promise.all(
    zones.map(async (entry): Promise<Sensor> => {
      const dir = join(base, entry.name)
      const own = cleanText((await readText(join(dir, 'type'))) ?? '', SENSOR_LABEL_MAX)
      return { file: join(dir, 'temp'), chip: entry.name, label: own || entry.name, misses: 0 }
    })
  )
}

/** Sensors that ended up with the same label are told apart by their chip. */
function distinguish(sensors: readonly Sensor[]): Sensor[] {
  const seen = new Map<string, number>()
  for (const sensor of sensors) {
    seen.set(sensor.label, (seen.get(sensor.label) ?? 0) + 1)
  }
  return sensors.map((sensor) =>
    seen.get(sensor.label) === 1
      ? sensor
      : { ...sensor, label: cleanText(`${sensor.label} (${sensor.chip})`, SENSOR_LABEL_MAX) }
  )
}

function createTemperatureReader(dirs: { hwmon: string; thermal: string }, supported: boolean) {
  let sensors: Sensor[] = []
  let rescanAt = 0
  let last: Reading<readonly TemperatureReading[]> = { value: [], problem: null }
  let readAt = Number.NEGATIVE_INFINITY
  return async (now: number): Promise<Reading<readonly TemperatureReading[]>> => {
    if (!supported) {
      return { value: [], problem: null }
    }
    if (now >= rescanAt) {
      rescanAt = now + RESCAN_MS
      readAt = Number.NEGATIVE_INFINITY
      try {
        const fromHwmon = await scanHwmon(dirs.hwmon)
        sensors = fromHwmon.length > 0 ? fromHwmon : await scanThermalZones(dirs.thermal)
      } catch {
        // Keep what the last scan found; the next one is a minute away.
      }
    }
    if (now - readAt < TEMPERATURE_REFRESH_MS) {
      return last
    }
    readAt = now
    const readings = await Promise.all(
      sensors
        .filter((sensor) => sensor.misses < SENSOR_MISSES)
        .map(async (sensor): Promise<TemperatureReading | null> => {
          const celsius = parseTemperature((await readText(sensor.file)) ?? '')
          sensor.misses = celsius === null ? sensor.misses + 1 : 0
          return celsius === null ? null : { label: sensor.label, celsius }
        })
    )
    const found = sortTemperatures(
      readings.filter((reading): reading is TemperatureReading => reading !== null)
    )
    // A sensor that fails is skipped, never shown as 0 °C; with none left, the host has no reading.
    last = { value: found, problem: found.length > 0 ? null : 'temperature (no readable sensor)' }
    return last
  }
}

/** `nvidia-smi`: probed once, then at most every ten seconds once it answers; a host without it is left alone. */
function createNvidiaReader(run: CommandRunner) {
  let worked = false
  let value: GpuUsage | null = null
  let nextAt = 0
  return async (now: number): Promise<Reading<GpuUsage | null>> => {
    if (now < nextAt) {
      return { value, problem: null }
    }
    // A host where it never worked is asked again this rarely, in case a driver appears.
    const nextTry = (): number => now + (worked ? NVIDIA_REFRESH_MS : NVIDIA_REPROBE_MS)
    let stdout: string
    try {
      stdout = await run(NVIDIA_SMI, NVIDIA_ARGS)
    } catch (error) {
      value = null
      nextAt = nextTry()
      // No NVIDIA driver at all is normal, and needs no explanation.
      const missing = !worked && (error as { code?: unknown } | null)?.code === 'ENOENT'
      return { value: null, problem: missing ? null : `nvidia-smi (${failureReason(error)})` }
    }
    value = busiestGpu(parseNvidiaSmi(stdout))
    worked = worked || value !== null
    nextAt = nextTry()
    return { value, problem: value ? null : 'nvidia-smi (no GPU in its output)' }
  }
}

/** A card's `gpu_busy_percent` file, with what else is known about the card and does not change. */
type SysfsGpu = { busy: string; vramUsed: string; vramTotalBytes: number | null; name: string }

/** The first `cardN` whose driver reports `gpu_busy_percent`: amdgpu, i915, xe and a few others. */
async function findSysfsGpu(dir: string): Promise<SysfsGpu | null> {
  const cards = (await readdir(dir).catch(() => [] as string[])).filter((name) => /^card\d+$/.test(name))
  for (const card of cards.sort(bySensorNumber)) {
    const device = join(dir, card, 'device')
    const busy = join(device, 'gpu_busy_percent')
    if ((await readText(busy)) === null) {
      continue
    }
    const driver = /^DRIVER=(.+)$/m.exec((await readText(join(device, 'uevent'))) ?? '')?.[1]
    return {
      busy,
      vramUsed: join(device, 'mem_info_vram_used'),
      vramTotalBytes: parseCount(await readText(join(device, 'mem_info_vram_total'))),
      name: cleanText(driver ?? '', GPU_NAME_MAX) || 'GPU'
    }
  }
  return null
}

function createGpuReader(input: { drm: string; run: CommandRunner; platform: string }) {
  const nvidia = createNvidiaReader(input.run)
  let card: SysfsGpu | null = null
  let rescanAt = 0

  /** AMD and Intel cards from sysfs, which costs two small reads a tick. */
  const fromSysfs = async (now: number): Promise<Reading<GpuUsage | null>> => {
    if (now >= rescanAt) {
      rescanAt = now + RESCAN_MS
      card = await findSysfsGpu(input.drm).catch(() => null)
    }
    if (card === null) {
      return { value: null, problem: null }
    }
    const utilization = parseCount(await readText(card.busy))
    if (utilization === null) {
      rescanAt = 0
      return { value: null, problem: null }
    }
    return {
      value: {
        name: card.name,
        utilization: clampPercent(utilization),
        vramUsedBytes: parseCount(await readText(card.vramUsed)),
        vramTotalBytes: card.vramTotalBytes
      },
      problem: null
    }
  }

  return async (now: number): Promise<Reading<GpuUsage | null>> => {
    const onLinux = input.platform === 'linux'
    const discrete: Reading<GpuUsage | null> =
      onLinux || input.platform === 'win32' ? await nvidia(now) : { value: null, problem: null }
    if (discrete.value || !onLinux) {
      return discrete
    }
    const integrated = await fromSysfs(now)
    // A working card on sysfs beats a failing nvidia-smi; otherwise say why there is no GPU.
    return integrated.value || !discrete.problem ? integrated : discrete
  }
}

export function createSystemReader(options: SystemReaderOptions = {}): SystemReader {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runCommand
  const procRoot = options.procRoot ?? '/proc'
  const sys = (...parts: string[]): string => join(options.sysRoot ?? '/sys', ...parts)
  const macMemory = createMacMemoryReader(run)

  return {
    async cpuTimes(): Promise<Reading<CpuTimes | null>> {
      if (platform === 'linux') {
        const stat = parseProcStat((await readText(join(procRoot, 'stat'))) ?? '')
        if (stat) {
          return { value: stat, problem: null }
        }
      }
      const fromOs = osCpuTimes()
      return { value: fromOs, problem: fromOs ? null : 'CPU (no time counter)' }
    },

    async memory(now: number): Promise<Reading<MemoryUsage | null>> {
      if (platform === 'linux') {
        const meminfo = parseMeminfo((await readText(join(procRoot, 'meminfo'))) ?? '')
        return meminfo
          ? { value: memoryUsageFrom(meminfo.totalBytes, meminfo.availableBytes), problem: null }
          : { value: null, problem: 'RAM (/proc/meminfo unreadable)' }
      }
      if (platform === 'darwin') {
        // What Node calls free is only unused pages there, so `vm_stat` is read instead.
        return macMemory(now)
      }
      if (platform === 'win32') {
        const value = osMemory()
        return { value, problem: value ? null : 'RAM (unreadable)' }
      }
      return { value: null, problem: `RAM (not readable on ${platform})` }
    },

    temperatures: createTemperatureReader(
      { hwmon: sys('class', 'hwmon'), thermal: sys('class', 'thermal') },
      platform === 'linux'
    ),

    gpu: createGpuReader({ drm: sys('class', 'drm'), run, platform })
  }
}
