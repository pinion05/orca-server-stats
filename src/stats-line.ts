// What the stats script prints, read back from a terminal's output: the newest whole line of the
// plugin's own among whatever else the terminal holds, checked field by field before it is shown.

import {
  cleanText,
  clampPercent,
  CPU_MODEL_MAX,
  GPU_NAME_MAX,
  parseTemperature,
  SENSOR_LABEL_MAX,
  sortTemperatures,
  type GpuUsage,
  type MetricsSnapshot,
  type Origin
} from './metrics'
import { STATS_MARKER } from './stats-command'

const KIB = 1024
const MIB = 1024 * KIB

/** How many lines after a cut one may be completed with. */
const REJOIN_LINES = 4

/** One sample of the stats script, as its JSON says it. */
export type StatsLine = {
  /** Counts up from 1, so a reader can tell a new sample from one it has seen. */
  seq: number
  /** CPU use in tenths of a percent, or null on the first sample, which has no earlier one. */
  cpuTenths: number | null
  cores: number | null
  /** Memory in KiB: total and used. */
  memTotalKb: number | null
  memUsedKb: number | null
  /** Thermal zones, in millidegrees Celsius. */
  temps: readonly { label: string; milli: number }[]
  load: readonly number[] | null
  uptimeSeconds: number | null
  model: string | null
  gpu: {
    name: string
    utilization: number
    vramUsedMib: number | null
    vramTotalMib: number | null
  } | null
}

/** Escape sequences a terminal can hold: colors and cursor moves, and title strings. */
const ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g

/** A line as text, without escape sequences or carriage returns. */
export function plainLine(line: string): string {
  return line.replace(ESCAPE, '').replace(/\r/g, '')
}

/**
 * The newest stats line in a terminal's output, or null when there is none that is whole. Only a
 * line that starts with the marker is read: what the shell or anything else printed is not it. A
 * line still being written does not parse and is left for the next reading.
 */
export function parseStatsLines(lines: readonly string[], marker: string = STATS_MARKER): StatsLine | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = plainLine(lines[index]).trimStart()
    if (!line.startsWith(marker)) {
      continue
    }
    const record = complete(line.slice(marker.length).trimStart(), lines.slice(index + 1))
    if (record) {
      return record
    }
  }
  return null
}

/**
 * The JSON that follows the marker. A line can come back cut in two, at a width or between two
 * reads; the rest is in the lines after it, and is joined with a space, which breaks no token of
 * JSON but keeps two cut numbers from reading as one.
 */
function complete(start: string, rest: readonly string[]): StatsLine | null {
  let text = start
  for (let joined = 0; ; joined += 1) {
    const record = readStatsLine(text)
    if (record) {
      return record
    }
    if (joined >= rest.length || joined >= REJOIN_LINES) {
      return null
    }
    text += ` ${plainLine(rest[joined]).trim()}`
  }
}

/** One JSON line, when it is the script's and every field in it is well formed; else null. */
export function readStatsLine(text: string): StatsLine | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || value.v !== 1 || !isCount(value.seq)) {
    return null
  }
  // The GPU is four fields beside the rest: `gpu` is the card's name, `gu` its use in percent,
  // `vu` and `vt` the memory in MiB. Without a name and a use there is none to show.
  const gpuName = typeof value.gpu === 'string' ? cleanText(value.gpu, GPU_NAME_MAX) : null
  const model = typeof value.model === 'string' ? cleanText(value.model, CPU_MODEL_MAX) || null : null
  return {
    seq: value.seq,
    cpuTenths: isCount(value.cpu) && value.cpu <= 100_000 ? value.cpu : null,
    cores: isCount(value.cores) ? value.cores : null,
    memTotalKb: isPair(value.mem) ? value.mem[0] : null,
    memUsedKb: isPair(value.mem) ? value.mem[1] : null,
    temps: Array.isArray(value.temp)
      ? value.temp.flatMap((zone) => {
          const label = isRecord(zone) ? zone.t : null
          if (typeof label !== 'string' || !isRecord(zone) || !isCount(zone.c)) {
            return []
          }
          return [{ label: cleanText(label, SENSOR_LABEL_MAX) || 'zone', milli: zone.c }]
        })
      : [],
    load: loadOf(value.load),
    uptimeSeconds: typeof value.up === 'number' && Number.isFinite(value.up) && value.up >= 0 ? value.up : null,
    model,
    gpu:
      gpuName !== null && isCount(value.gu)
        ? {
            name: gpuName || 'GPU',
            utilization: clampPercent(value.gu),
            vramUsedMib: isCount(value.vu) ? value.vu : null,
            vramTotalMib: isCount(value.vt) && value.vt > 0 ? value.vt : null
          }
        : null
  }
}

/** `a b c` as the script writes it; anything else is nothing. */
function loadOf(value: unknown): readonly number[] | null {
  if (typeof value !== 'string') {
    return null
  }
  const loads = value.trim().split(/\s+/).map(Number)
  return loads.length === 3 && loads.every((load) => Number.isFinite(load) && load >= 0) ? loads : null
}

/**
 * The reading as the item shows it. A metric the script left out is named in `problems`, since on
 * another machine there is no telling why without asking.
 */
export function statsLineToSnapshot(line: StatsLine, origin: Origin | null): MetricsSnapshot {
  const problems: string[] = []
  const cpu =
    line.cpuTenths !== null && line.cores !== null
      ? { percent: clampPercent(line.cpuTenths / 10), cores: line.cores }
      : null
  if (!cpu) {
    problems.push('CPU (not reported)')
  }
  let memory = null
  if (line.memTotalKb !== null && line.memUsedKb !== null && line.memTotalKb > 0) {
    const totalBytes = line.memTotalKb * KIB
    const usedBytes = Math.min(line.memUsedKb, line.memTotalKb) * KIB
    memory = { usedBytes, totalBytes, percent: (usedBytes / totalBytes) * 100 }
  } else {
    problems.push('RAM (not reported)')
  }
  const temperatures = sortTemperatures(
    line.temps.flatMap((zone) => {
      const celsius = parseTemperature(zone.milli)
      return celsius === null ? [] : [{ label: zone.label, celsius }]
    })
  )
  if (temperatures.length === 0) {
    problems.push('temperature (no readable sensor)')
  }
  const gpu: GpuUsage | null = line.gpu
    ? {
        name: line.gpu.name,
        utilization: line.gpu.utilization,
        vramUsedBytes: line.gpu.vramUsedMib !== null && line.gpu.vramTotalMib !== null ? line.gpu.vramUsedMib * MIB : null,
        vramTotalBytes: line.gpu.vramTotalMib !== null ? line.gpu.vramTotalMib * MIB : null
      }
    : null
  return {
    cpu,
    memory,
    temperatures,
    gpu,
    cpuModel: line.model,
    load: line.load,
    uptimeSeconds: line.uptimeSeconds,
    problems,
    origin
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-negative whole number, as the script writes its counts. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isCount(value[0]) && isCount(value[1])
}
