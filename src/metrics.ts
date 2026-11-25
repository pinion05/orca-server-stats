// Numbers and strings: what ./system.ts read, turned into the status bar item. Nothing here
// touches the machine, so every function is tested with fixtures rather than real sensors.

/** Orca refuses a status bar update whose text is longer than this. */
export const STATUS_TEXT_MAX = 64
/** Orca refuses a status bar update whose tooltip is longer than this. */
export const TOOLTIP_MAX = 256
/**
 * What a tooltip is kept to where it can be. Orca draws it as one unwrapped line of small text, so
 * this comes to roughly a thousand pixels: it fits a window about that wide, and the hover still
 * says what the machine is doing.
 */
const TOOLTIP_TARGET = 180
/** Readings a roomier tooltip has to fit before the item switches to it. */
const TOOLTIP_SETTLE_READINGS = 8
/** The room a remote reading's origin takes at the start of the item and of the tooltip. */
export const ORIGIN_BAR_MAX = 14
export const ORIGIN_TOOLTIP_MAX = 48

const KIB = 1024
const MIB = 1024 * KIB
const GIB = 1024 * MIB

/** Caps on words that come from the machine, so one long name cannot crowd out the rest. */
export const SENSOR_LABEL_MAX = 24
export const CPU_MODEL_MAX = 48
export const GPU_NAME_MAX = 32
export const CHIP_MAX = 16
const PROBLEM_MAX = 48
const PROBLEMS_MAX = 3

/** A sensor reading 0 °C, or outside this range, has nothing to report. */
const CELSIUS_MIN = -40
const CELSIUS_MAX = 150

/** How many sensors the fullest tooltip lists. */
const SENSORS_FULL = 5
const SENSORS_FEW = 3

const NO_READING = 'No host stats'
const SEPARATOR = ' · '

/** CPU time in ticks since boot. `idle` counts iowait as idle, the way top does. */
export type CpuTimes = { total: number; idle: number }

export type CpuUsage = { percent: number; cores: number }

export type MemoryUsage = { usedBytes: number; totalBytes: number; percent: number }

/** One sensor. `label` is what the tooltip shows, such as `Core` or `board temp3`. */
export type TemperatureReading = { label: string; celsius: number }

/** Where a reading came from when it is not this computer: what the item and the tooltip start with. */
export type Origin = { bar: string; tooltip: string }

export type GpuUsage = {
  name: string
  utilization: number
  vramUsedBytes: number | null
  vramTotalBytes: number | null
}

export type MetricsSnapshot = {
  cpu: CpuUsage | null
  memory: MemoryUsage | null
  /** Readable sensors, hottest first. */
  temperatures: readonly TemperatureReading[]
  gpu: GpuUsage | null
  cpuModel: string | null
  load: readonly number[] | null
  uptimeSeconds: number | null
  /** Why a reading is missing, for the tooltip. Never a reason to stop the worker. */
  problems: readonly string[]
  /** Another machine the reading came from, or null for this one. */
  origin: Origin | null
}

export type StatusTone = 'neutral' | 'warning' | 'danger'

/** A reading with nothing in it but the reasons why, shown while a source is still starting. */
export function emptySnapshot(problems: readonly string[], origin: Origin | null = null): MetricsSnapshot {
  return {
    cpu: null,
    memory: null,
    temperatures: [],
    gpu: null,
    cpuModel: null,
    load: null,
    uptimeSeconds: null,
    problems: [...problems],
    origin
  }
}

/** What `statusBar.update` sets on the plugin's one status bar item. */
export type StatusItem = {
  id: string
  text: string
  tone: StatusTone
  tooltip: string
  visible: boolean
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(100, Math.max(0, value))
}

/** What Orca strips from text it shows: control, format and separator characters. */
const UNSAFE = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu
/** Line breaks, which Orca turns into spaces: its tooltips and labels are one line. */
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g

/** Words that came from the machine (a sensor label, a CPU model, a GPU name) as one short line. */
export function cleanText(raw: string, max: number): string {
  return clip(raw.replace(LINE_BREAKS, ' ').replace(UNSAFE, '').replace(/\s+/g, ' ').trim(), max)
}

/** `text` cut to at most `max` characters, with an ellipsis when it did not fit. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const end = max - 1
  // Never cut between the two halves of a surrogate pair.
  const before = text.charCodeAt(end - 1)
  return `${text.slice(0, before >= 0xd800 && before <= 0xdbff ? end - 1 : end)}…`
}

/**
 * The first line of `/proc/stat`: `cpu user nice system idle iowait irq softirq steal guest
 * guest_nice`. `guest` repeats time already in `user`, so the total stops before it.
 */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith('cpu '))
  if (!line) {
    return null
  }
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number)
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
    return null
  }
  const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0)
  if (total <= 0) {
    return null
  }
  return { total, idle: Math.min(values[3] + (values[4] ?? 0), total) }
}

/** CPU use between two samples, so the number describes that interval and not all time since boot. */
export function cpuUsageBetween(previous: CpuTimes, next: CpuTimes, cores: number): CpuUsage | null {
  const total = next.total - previous.total
  const idle = next.idle - previous.idle
  if (total <= 0 || idle < 0) {
    return null
  }
  return { percent: clampPercent(((total - idle) / total) * 100), cores }
}

/** `/proc/meminfo`, whose sizes are in kB (1024 bytes). */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const values = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^:\s]+):\s*(\d+)\s*kB\s*$/.exec(line.trim())
    if (match) {
      values.set(match[1].toLowerCase(), Number(match[2]))
    }
  }
  const totalKb = values.get('memtotal') ?? 0
  if (totalKb <= 0) {
    return null
  }
  const availableKb =
    values.get('memavailable') ??
    (values.get('memfree') ?? 0) + (values.get('buffers') ?? 0) + (values.get('cached') ?? 0)
  return { totalBytes: totalKb * KIB, availableBytes: Math.min(availableKb, totalKb) * KIB }
}

export function memoryUsageFrom(totalBytes: number, availableBytes: number): MemoryUsage | null {
  if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes) || totalBytes <= 0) {
    return null
  }
  const usedBytes = totalBytes - Math.min(Math.max(0, availableBytes), totalBytes)
  return { usedBytes, totalBytes, percent: (usedBytes / totalBytes) * 100 }
}

/** `sysctl -n hw.memsize` on a Mac: how many bytes of memory it has. */
export function parseMemsize(text: string): number | null {
  const bytes = Number(text.trim())
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null
}

/**
 * What macOS `vm_stat` says of memory: the page size, and the pages in use. In use are the
 * anonymous pages, the wired pages and the pages the compressor occupies, which is what Activity
 * Monitor calls app memory, wired memory and compressed. It is an approximation of its "Memory
 * Used", not the same figure.
 */
export function parseVmStat(text: string): { pageSize: number; usedPages: number } | null {
  let pageSize: number | null = null
  const pages = new Map<string, number>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const size = /page size of (\d+) bytes/i.exec(line)
    if (size) {
      pageSize = Number(size[1])
    }
    const count = /^(?:Pages (.+?)|(Anonymous pages)):\s*([\d,]+)\.?\s*$/i.exec(line)
    if (count) {
      pages.set((count[1] ?? count[2]).toLowerCase(), Number(count[3].replace(/,/g, '')))
    }
  }
  const wired = pages.get('wired down')
  const compressed = pages.get('occupied by compressor')
  const anonymous = pages.get('anonymous pages')
  const app = anonymous ?? pages.get('active')
  if (!pageSize || wired === undefined || compressed === undefined || app === undefined) {
    return null
  }
  return { pageSize, usedPages: app + wired + compressed }
}

/**
 * A sysfs temperature in millidegrees Celsius, though a few drivers write whole degrees. Zero and
 * readings outside a plausible range are a sensor with nothing to report, not a measurement.
 */
export function parseTemperature(raw: string | number): number | null {
  const text = String(raw).trim()
  if (text === '') {
    return null
  }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return null
  }
  const celsius = Math.abs(value) >= 1000 ? value / 1000 : value
  if (celsius === 0 || celsius < CELSIUS_MIN || celsius > CELSIUS_MAX) {
    return null
  }
  return Math.round(celsius * 10) / 10
}

/** Hottest first; sensors at the same temperature keep the order they were found in. */
export function sortTemperatures(readings: readonly TemperatureReading[]): TemperatureReading[] {
  return [...readings].sort((left, right) => right.celsius - left.celsius)
}

/**
 * `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total
 * --format=csv,noheader,nounits`, one line per GPU. A GPU with nothing to report (`[N/A]`) is left
 * out; the memory columns are MiB.
 */
export function parseNvidiaSmi(stdout: string): GpuUsage[] {
  const gpus: GpuUsage[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const parts = rawLine.split(',').map((part) => part.trim())
    const utilization = Number(parts[1])
    if (parts.length < 4 || parts[0] === '' || !Number.isFinite(utilization)) {
      continue
    }
    gpus.push({
      name: cleanText(parts[0], GPU_NAME_MAX),
      utilization: clampPercent(utilization),
      vramUsedBytes: mibToBytes(parts[2]),
      vramTotalBytes: mibToBytes(parts[3])
    })
  }
  return gpus
}

/** The GPU with the most use: what a status bar has room for when there are several. */
export function busiestGpu(gpus: readonly GpuUsage[]): GpuUsage | null {
  let busiest: GpuUsage | null = null
  for (const gpu of gpus) {
    if (!busiest || gpu.utilization > busiest.utilization) {
      busiest = gpu
    }
  }
  if (busiest && gpus.length > 1) {
    // Which one this is, out of how many: `[3/8]` at most, so the name leaves room for it.
    const name = cleanText(busiest.name, GPU_NAME_MAX - 8).trimEnd()
    return { ...busiest, name: `${name} [${gpus.indexOf(busiest) + 1}/${gpus.length}]` }
  }
  return busiest
}

function mibToBytes(value: string): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number * MIB) : null
}

/** Whole gibibytes with one decimal, for the short label: `7.3`. */
export function formatGibibytes(bytes: number): string {
  return (bytes / GIB).toFixed(1)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '–'
  }
  if (bytes >= GIB) {
    return `${(bytes / GIB).toFixed(1)} GiB`
  }
  if (bytes >= MIB) {
    return `${Math.round(bytes / MIB)} MiB`
  }
  return `${Math.round(bytes / KIB)} KiB`
}

/** `2d 3h`, `3h 4m`, or `5m`. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '–'
  }
  const whole = Math.floor(seconds)
  const days = Math.floor(whole / 86400)
  const hours = Math.floor((whole % 86400) / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  if (days > 0) {
    return `${days}d ${hours}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

export function formatDegrees(celsius: number): string {
  return `${Math.round(celsius)}°C`
}

/**
 * The short label in the status bar: `CPU 12% · RAM 2.0/8.0G · 62°C · GPU 0%`, or with the name of
 * another machine first: `my-server · CPU 12% · …`. A metric the host cannot read is left out, and
 * an item with nothing at all says so instead of disappearing.
 */
export function formatStatusText(snapshot: MetricsSnapshot): string {
  // The other machine's name is cut here too, whoever made the reading: a long one would leave no room for the numbers.
  const origin = snapshot.origin ? clip(snapshot.origin.bar, ORIGIN_BAR_MAX) : null
  const parts: string[] = origin ? [origin] : []
  if (snapshot.cpu) {
    parts.push(`CPU ${Math.round(snapshot.cpu.percent)}%`)
  }
  if (snapshot.memory) {
    parts.push(`RAM ${formatGibibytes(snapshot.memory.usedBytes)}/${formatGibibytes(snapshot.memory.totalBytes)}G`)
  }
  if (snapshot.temperatures.length > 0) {
    parts.push(formatDegrees(snapshot.temperatures[0].celsius))
  }
  if (snapshot.gpu) {
    parts.push(`GPU ${Math.round(snapshot.gpu.utilization)}%`)
  }
  const hasReading = parts.length > (origin ? 1 : 0)
  return clip(hasReading ? parts.join(SEPARATOR) : [origin, NO_READING].filter(Boolean).join(SEPARATOR), STATUS_TEXT_MAX)
}

/** How much of the snapshot a tooltip shows. */
type Detail = {
  /** The CPU model. */
  model: boolean
  /** How many sensors are listed, from the hottest down; 0 keeps only the headline temperature. */
  sensors: number
  /** The GPU's memory. */
  vram: boolean
  /** Load average and uptime. */
  extra: boolean
}

/**
 * From the most detail to the least. What only the tooltip shows, per-sensor temperatures and GPU
 * memory, is kept longest; what the status bar already says goes first, then what is merely nice
 * to know.
 */
const DETAIL_LEVELS: readonly Detail[] = [
  { model: true, sensors: SENSORS_FULL, vram: true, extra: true },
  { model: false, sensors: SENSORS_FULL, vram: true, extra: true },
  { model: false, sensors: SENSORS_FULL, vram: true, extra: false },
  { model: false, sensors: SENSORS_FEW, vram: true, extra: false },
  { model: false, sensors: 1, vram: true, extra: false },
  { model: false, sensors: 0, vram: true, extra: false },
  { model: false, sensors: 0, vram: false, extra: false }
]

/** The most detail that fits `target`, else that fits `max`, else the least there is. */
function detailLevel(lines: readonly string[], target: number, max: number): number {
  const fitting = (limit: number): number => lines.findIndex((line) => line.length <= limit)
  const roomy = fitting(target)
  if (roomy >= 0) {
    return roomy
  }
  const allowed = fitting(max)
  return allowed >= 0 ? allowed : lines.length - 1
}

/**
 * The hover text: the numbers behind the label. Orca draws a tooltip as one unwrapped line, and a
 * long one runs off the edge of the window, so the first level short enough for most windows is
 * shown. A machine with a lot to say gets the first level Orca still accepts, and failing that
 * the least of it, cut short.
 */
export function formatTooltip(
  snapshot: MetricsSnapshot,
  target: number = TOOLTIP_TARGET,
  max: number = TOOLTIP_MAX
): string {
  const lines = DETAIL_LEVELS.map((level) => composeTooltip(snapshot, level))
  const line = lines[detailLevel(lines, target, max)]
  return line.length <= max ? line : clip(line, max)
}

/** The tooltip for one reading; a selector made by `createTooltipSelector` remembers the one before. */
export type TooltipSelector = {
  (snapshot: MetricsSnapshot): string
  /** Forgets what was shown, for a new source of readings. */
  reset?(): void
}

/**
 * The tooltip from one reading to the next, held steady: a reading is long and short by turns as
 * its numbers change, and the level that fits changes with them. Less detail is given at once,
 * since it has to be; more comes back only once the same level has fit for `settle` readings.
 */
export function createTooltipSelector(
  options: { settle?: number; target?: number; max?: number } = {}
): TooltipSelector {
  const settle = options.settle ?? TOOLTIP_SETTLE_READINGS
  const target = options.target ?? TOOLTIP_TARGET
  const max = options.max ?? TOOLTIP_MAX
  let current = -1
  let wanted = -1
  let fittingFor = 0
  const selector = (snapshot: MetricsSnapshot): string => {
    const lines = DETAIL_LEVELS.map((level) => composeTooltip(snapshot, level))
    const level = detailLevel(lines, target, max)
    if (current < 0 || level >= current) {
      current = level
      fittingFor = 0
    } else if (level === wanted) {
      fittingFor += 1
      if (fittingFor >= settle) {
        current = level
        fittingFor = 0
      }
    } else {
      fittingFor = 1
    }
    wanted = level
    const line = lines[current]
    return line.length <= max ? line : clip(line, max)
  }
  selector.reset = (): void => {
    current = -1
    wanted = -1
    fittingFor = 0
  }
  return selector
}

function composeTooltip(snapshot: MetricsSnapshot, level: Detail): string {
  const parts: string[] = []
  if (snapshot.origin) {
    parts.push(clip(snapshot.origin.tooltip, ORIGIN_TOOLTIP_MAX))
  }
  if (snapshot.cpu) {
    const percent = snapshot.cpu.percent.toFixed(1)
    parts.push(
      snapshot.cpu.cores > 0 ? `CPU ${percent}% (${snapshot.cpu.cores} threads)` : `CPU ${percent}%`
    )
    if (level.model && snapshot.cpuModel) {
      parts.push(snapshot.cpuModel)
    }
  }
  if (snapshot.memory) {
    const { usedBytes, totalBytes, percent } = snapshot.memory
    parts.push(`RAM ${formatSizePair(usedBytes, totalBytes)} (${Math.round(percent)}%)`)
  }
  const temperature = describeTemperatures(snapshot.temperatures, level.sensors)
  if (temperature) {
    parts.push(temperature)
  }
  if (snapshot.gpu) {
    const { name, utilization, vramUsedBytes, vramTotalBytes } = snapshot.gpu
    let gpu = `GPU ${name} ${Math.round(utilization)}%`
    if (level.vram && vramUsedBytes !== null && vramTotalBytes !== null) {
      gpu += `, VRAM ${formatBytes(vramUsedBytes)}/${formatBytes(vramTotalBytes)}`
    }
    parts.push(gpu)
  }
  if (level.extra) {
    if (snapshot.load && snapshot.load.some((value) => value > 0)) {
      parts.push(`load ${snapshot.load.map((value) => value.toFixed(2)).join(' ')}`)
    }
    if (snapshot.uptimeSeconds !== null) {
      parts.push(`up ${formatUptime(snapshot.uptimeSeconds)}`)
    }
  }
  if (snapshot.problems.length > 0) {
    const problems = snapshot.problems.slice(0, PROBLEMS_MAX).map((problem) => cleanText(problem, PROBLEM_MAX))
    parts.push(`unavailable: ${problems.join(', ')}`)
  }
  return parts.join(SEPARATOR)
}

/** Two sizes in one unit: `2.0/8.0 GiB`. */
function formatSizePair(usedBytes: number, totalBytes: number): string {
  if (totalBytes < MIB) {
    return `${(usedBytes / KIB).toFixed(1)}/${(totalBytes / KIB).toFixed(1)} KiB`
  }
  if (totalBytes < GIB) {
    return `${(usedBytes / MIB).toFixed(1)}/${(totalBytes / MIB).toFixed(1)} MiB`
  }
  return `${(usedBytes / GIB).toFixed(1)}/${(totalBytes / GIB).toFixed(1)} GiB`
}

function describeTemperatures(readings: readonly TemperatureReading[], count: number): string | null {
  if (readings.length === 0) {
    return null
  }
  if (count === 0) {
    return formatDegrees(readings[0].celsius)
  }
  const shown = readings.slice(0, count)
  const rest = readings.length - shown.length
  const listed = shown.map((reading) => `${reading.label} ${Math.round(reading.celsius)}°`)
  // How many are left out, unless the room that is left is enough for one sensor only.
  return listed.join(', ') + (rest > 0 && count > 1 ? ` +${rest} more` : '')
}

/** Colours the item when something is near its limit. The bar stays readable either way. */
export function toneFor(snapshot: MetricsSnapshot): StatusTone {
  const cpu = snapshot.cpu?.percent ?? 0
  const memory = snapshot.memory?.percent ?? 0
  const celsius = snapshot.temperatures[0]?.celsius ?? 0
  if (cpu >= 90 || memory >= 90 || celsius >= 85) {
    return 'danger'
  }
  if (cpu >= 75 || memory >= 80 || celsius >= 75) {
    return 'warning'
  }
  return 'neutral'
}

/** The whole update for the plugin's status bar item, named by `itemId` in its manifest. */
export function statusItemFor(
  snapshot: MetricsSnapshot,
  itemId: string,
  tooltip: TooltipSelector = formatTooltip
): StatusItem {
  return {
    id: itemId,
    text: formatStatusText(snapshot),
    tone: toneFor(snapshot),
    tooltip: tooltip(snapshot),
    visible: true
  }
}
