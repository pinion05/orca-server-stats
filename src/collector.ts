// One reading of the machine: asks ./system.ts for each metric and gathers the answers into one
// snapshot. A metric that fails is named in the snapshot and the others still come through.

import * as os from 'node:os'
import {
  cpuUsageBetween,
  type CpuTimes,
  type CpuUsage,
  type MemoryUsage,
  type MetricsSnapshot,
  type TemperatureReading
} from './metrics'
import { cpuFacts, failureReason, type Reading, type SystemReader } from './system'

/** CPU use is the change between two readings, so the first one waits this long for a second. */
const PRIME_MS = 400

export type Collector = {
  /** Never rejects: what could not be read is missing from the answer, with a reason. */
  sample(): Promise<MetricsSnapshot>
}

export type CollectorOptions = {
  reader: SystemReader
  primeMs?: number
  /** The real one is a timer; tests answer at once. */
  wait?: (ms: number) => Promise<void>
}

export function createCollector(options: CollectorOptions): Collector {
  const { reader } = options
  const facts = cpuFacts()
  const cores = facts.cores ?? 0
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  /** The CPU reading the next sample is measured from. */
  let baseline: CpuTimes | null = null
  /** The last CPU use measured, kept for a tick whose two readings are too close to differ. */
  let lastCpu: CpuUsage | null = null

  /** Between two readings, so the number is this interval's use and not the average since boot. */
  const cpu = async (): Promise<Reading<CpuUsage | null>> => {
    const first = await reader.cpuTimes()
    if (!first.value) {
      return { value: null, problem: first.problem }
    }
    const from = baseline ?? first.value
    let next = first.value
    if (!baseline) {
      await wait(options.primeMs ?? PRIME_MS)
      const second = await reader.cpuTimes()
      if (!second.value) {
        return { value: null, problem: second.problem }
      }
      next = second.value
    }
    baseline = next
    const measured = cpuUsageBetween(from, next, cores)
    if (measured) {
      lastCpu = measured
    }
    return { value: lastCpu, problem: null }
  }

  /** A reader that throws is a bug, not a reason to lose the other metrics. */
  const guarded = async <T>(
    name: string,
    fallback: T,
    read: () => Promise<Reading<T>>
  ): Promise<Reading<T>> => {
    try {
      return await read()
    } catch (error) {
      return { value: fallback, problem: `${name} (${failureReason(error)})` }
    }
  }

  const optional = <T>(read: () => T): T | null => {
    try {
      return read()
    } catch {
      return null
    }
  }

  return {
    async sample(): Promise<MetricsSnapshot> {
      // A monotonic clock: the readers time their caches with it, and the wall clock can jump.
      const now = performance.now()
      const [cpuReading, memory, temperatures, gpu] = await Promise.all([
        guarded('CPU', null, cpu),
        guarded<MemoryUsage | null>('RAM', null, () => reader.memory(now)),
        guarded<readonly TemperatureReading[]>('temperature', [], () => reader.temperatures(now)),
        guarded('GPU', null, () => reader.gpu(now))
      ])
      const problems = [cpuReading, memory, temperatures, gpu]
        .map((reading) => reading.problem)
        .filter((problem): problem is string => problem !== null)
      return {
        cpu: cpuReading.value,
        memory: memory.value,
        temperatures: temperatures.value,
        gpu: gpu.value,
        cpuModel: facts.model,
        load: optional(() => os.loadavg()),
        uptimeSeconds: optional(() => os.uptime()),
        problems,
        origin: null
      }
    }
  }
}
