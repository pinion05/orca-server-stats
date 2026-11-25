// The arithmetic and the exact status bar strings, with no machine sensors involved: every input
// here is a fixture, so these tests come out the same on any host.

import { assert, test } from 'orca/testing'
import {
  busiestGpu,
  cleanText,
  clip,
  cpuUsageBetween,
  createTooltipSelector,
  emptySnapshot,
  formatBytes,
  formatStatusText,
  formatTooltip,
  formatUptime,
  memoryUsageFrom,
  parseMeminfo,
  parseMemsize,
  parseNvidiaSmi,
  parseProcStat,
  parseTemperature,
  parseVmStat,
  sortTemperatures,
  statusItemFor,
  STATUS_TEXT_MAX,
  TOOLTIP_MAX,
  toneFor,
  type MetricsSnapshot
} from './metrics'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

/** A made-up CPU model name, 45 characters: as long as a real one, so the tooltip has detail to give up. */
const MODEL = 'Example CPU Model 000 w/ Example GPU Graphics'
/** What the item calls another machine: a server it is on, and the workspace measured there. */
const ORIGIN = { bar: 'my-server', tooltip: 'example-project on my-server' }

const snapshot = (overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot => ({
  cpu: { percent: 12.4, cores: 4 },
  memory: { usedBytes: 2 * GIB, totalBytes: 8 * GIB, percent: 25 },
  temperatures: [
    { label: 'Sensor 1', celsius: 63.2 },
    { label: 'Core', celsius: 61.5 },
    { label: 'CPU 0', celsius: 61 }
  ],
  gpu: null,
  cpuModel: MODEL,
  load: [1.47, 1.8, 2.17],
  uptimeSeconds: 90_061,
  problems: [],
  origin: null,
  ...overrides
})

const nvidia = {
  name: 'NVIDIA GeForce RTX 4090',
  utilization: 13,
  vramUsedBytes: 926 * MIB,
  vramTotalBytes: 24564 * MIB
}

test('reads CPU time from /proc/stat without counting guest time twice', () => {
  const stat = ['cpu  100 0 100 800 50 0 0 0 70 80', 'cpu0 40 0 40 400 25 0 0 0 35 40'].join('\n')
  assert.deepEqual(parseProcStat(stat), { total: 1050, idle: 850 })
  assert.equal(parseProcStat('intr 12345'), null)
  assert.equal(parseProcStat('cpu  user nice system idle'), null)
  assert.equal(parseProcStat('cpu  1 2 three 4'), null)
})

test('measures CPU use between two readings, not the average since boot', () => {
  const earlier = { total: 1000, idle: 800 }
  assert.deepEqual(cpuUsageBetween(earlier, { total: 2000, idle: 1700 }, 4), {
    percent: 10,
    cores: 4
  })
  // No tick between the two: nothing to measure. A counter that went backwards is a reboot.
  assert.equal(cpuUsageBetween(earlier, earlier, 4), null)
  assert.equal(cpuUsageBetween({ total: 2000, idle: 1700 }, earlier, 4), null)
})

test('parses /proc/meminfo and prefers MemAvailable', () => {
  const meminfo = [
    'MemTotal:       16000000 kB',
    'MemFree:         1000000 kB',
    'MemAvailable:    4000000 kB',
    'Buffers:          500000 kB',
    'HugePages_Total:       0'
  ].join('\n')
  assert.deepEqual(parseMeminfo(meminfo), {
    totalBytes: 16_000_000 * 1024,
    availableBytes: 4_000_000 * 1024
  })
  assert.deepEqual(memoryUsageFrom(16 * GIB, 4 * GIB), {
    usedBytes: 12 * GIB,
    totalBytes: 16 * GIB,
    percent: 75
  })
  assert.equal(parseMeminfo('nonsense'), null)
  assert.equal(memoryUsageFrom(0, 0), null)
})

test('falls back to MemFree + Buffers + Cached when MemAvailable is absent', () => {
  const meminfo = [
    'MemTotal: 8000000 kB',
    'MemFree: 1000000 kB',
    'Buffers: 500000 kB',
    'Cached: 2500000 kB'
  ].join('\n')
  assert.deepEqual(parseMeminfo(meminfo), {
    totalBytes: 8_000_000 * 1024,
    availableBytes: 4_000_000 * 1024
  })
})

test('turns millidegree sensor files into readings and drops what is not one', () => {
  assert.equal(parseTemperature('45000'), 45)
  assert.equal(parseTemperature('57850'), 57.9)
  assert.equal(parseTemperature(61), 61)
  assert.equal(parseTemperature('-5000'), -5)
  // A sensor that reports nothing, not a cold machine.
  assert.equal(parseTemperature('0'), null)
  assert.equal(parseTemperature('-50000'), null)
  assert.equal(parseTemperature('151000'), null)
  assert.equal(parseTemperature(''), null)
  assert.equal(parseTemperature('not a number'), null)
})

test('lists sensors hottest first, keeping the order of equals', () => {
  const sorted = sortTemperatures([
    { label: 'edge', celsius: 55 },
    { label: 'Core', celsius: 61.5 },
    { label: 'CPU', celsius: 61.5 },
    { label: 'Composite', celsius: 45 }
  ])
  assert.deepEqual(
    sorted.map((reading) => reading.label),
    ['Core', 'CPU', 'edge', 'Composite']
  )
  assert.deepEqual(sortTemperatures([]), [])
})

test('parses nvidia-smi output, with VRAM in MiB', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 12, 1234, 24564\n'), [
    {
      name: 'NVIDIA GeForce RTX 4090',
      utilization: 12,
      vramUsedBytes: 1234 * MIB,
      vramTotalBytes: 24564 * MIB
    }
  ])
  assert.deepEqual(parseNvidiaSmi(''), [])
  // A GPU with nothing to report, and a reading over 100%.
  assert.deepEqual(parseNvidiaSmi('Tesla T4, [N/A], 1, 2'), [])
  assert.equal(parseNvidiaSmi('GPU, 150, 0, 0')[0]?.utilization, 100)
  assert.equal(parseNvidiaSmi('GPU, 5, [N/A], 24564')[0]?.vramUsedBytes, null)
})

test('shows the busiest of several GPUs and says which one it is', () => {
  const gpus = parseNvidiaSmi(['Tesla T4, 0, 1, 2', 'Tesla T4, 96, 3, 4', 'Tesla T4, 12, 5, 6'].join('\n'))
  assert.equal(busiestGpu(gpus)?.name, 'Tesla T4 [2/3]')
  assert.equal(busiestGpu(gpus)?.vramUsedBytes, 3 * MIB)
  assert.equal(busiestGpu(gpus.slice(0, 1))?.name, 'Tesla T4')
  assert.equal(busiestGpu([]), null)
})

test('cleans words that come from the machine down to one short line', () => {
  assert.equal(cleanText('  Core\t#0\r\n\u0000\u200b  ', 24), 'Core #0')
  assert.equal(cleanText('x'.repeat(50), 24).length, 24)
  assert.ok(cleanText('x'.repeat(50), 24).endsWith('…'))
  assert.equal(cleanText('\u0000\u200b', 24), '')
  assert.equal(clip('abc', 3), 'abc')
  assert.equal(clip('abcd', 3), 'ab…')
  // Not between the two halves of an emoji.
  assert.equal(clip('ab😀cd', 4), 'ab…')
})

test('formats bytes and uptime', () => {
  assert.equal(formatBytes(GIB), '1.0 GiB')
  assert.equal(formatBytes(1.5 * GIB), '1.5 GiB')
  assert.equal(formatBytes(926 * MIB), '926 MiB')
  assert.equal(formatBytes(2048), '2 KiB')
  assert.equal(formatBytes(Number.NaN), '–')
  assert.equal(formatUptime(90_061), '1d 1h')
  assert.equal(formatUptime(3661), '1h 1m')
  assert.equal(formatUptime(61), '1m')
})

test('the status bar shows CPU, RAM, the hottest sensor and the GPU', () => {
  assert.equal(formatStatusText(snapshot()), 'CPU 12% · RAM 2.0/8.0G · 63°C')
  assert.equal(
    formatStatusText(snapshot({ gpu: { name: 'amdgpu', utilization: 7.6, vramUsedBytes: null, vramTotalBytes: null } })),
    'CPU 12% · RAM 2.0/8.0G · 63°C · GPU 8%'
  )
})

test('leaves out a metric the host cannot read, and says so when it can read none', () => {
  assert.equal(formatStatusText(snapshot({ temperatures: [], gpu: null })), 'CPU 12% · RAM 2.0/8.0G')
  const nothing = snapshot({ cpu: null, memory: null, temperatures: [], problems: ['CPU (EACCES)'] })
  assert.equal(formatStatusText(nothing), 'No host stats')
  // What can still be read is still shown.
  assert.equal(formatTooltip(nothing), 'load 1.47 1.80 2.17 · up 1d 1h · unavailable: CPU (EACCES)')
})

test('the tooltip carries the detail behind the label', () => {
  const cpu = 'CPU 12.4% (4 threads)'
  const ram = 'RAM 2.0/8.0 GiB (25%)'
  const sensors = 'Sensor 1 63°, Core 62°, CPU 0 61°'
  const gpu = 'GPU NVIDIA GeForce RTX 4090 13%, VRAM 926 MiB/24.0 GiB'
  const extra = 'load 1.47 1.80 2.17 · up 1d 1h'
  assert.equal(formatTooltip(snapshot()), `${cpu} · ${MODEL} · ${ram} · ${sensors} · ${extra}`)
  // With a GPU to name, that is too long for most windows: the CPU model is the first to go.
  assert.equal(formatTooltip(snapshot({ gpu: nvidia })), `${cpu} · ${ram} · ${sensors} · ${gpu} · ${extra}`)
  // Given the room, it is back.
  assert.equal(
    formatTooltip(snapshot({ gpu: nvidia }), 256),
    `${cpu} · ${MODEL} · ${ram} · ${sensors} · ${gpu} · ${extra}`
  )
  // Windows reports no load average: that part is left out rather than shown as zeros.
  assert.ok(!formatTooltip(snapshot({ load: [0, 0, 0] })).includes('load'))
  // Under a gibibyte, a pair of sizes is shown in mebibytes.
  const small = snapshot({
    cpu: null,
    cpuModel: null,
    temperatures: [],
    load: null,
    uptimeSeconds: null,
    memory: { usedBytes: 312 * MIB, totalBytes: 980 * MIB, percent: 31.8 }
  })
  assert.equal(formatTooltip(small), 'RAM 312.0/980.0 MiB (32%)')
})

test('the tooltip gives up detail in order when it would not fit', () => {
  const crowded = snapshot({
    temperatures: Array.from({ length: 8 }, (_, index) => ({ label: `Sensor ${index}`, celsius: 70 - index })),
    gpu: nvidia,
    problems: ['temperature (no readable sensor)']
  })
  const cpu = 'CPU 12.4% (4 threads)'
  const ram = 'RAM 2.0/8.0 GiB (25%)'
  const five = 'Sensor 0 70°, Sensor 1 69°, Sensor 2 68°, Sensor 3 67°, Sensor 4 66° +3 more'
  const three = 'Sensor 0 70°, Sensor 1 69°, Sensor 2 68° +5 more'
  const withVram = 'GPU NVIDIA GeForce RTX 4090 13%, VRAM 926 MiB/24.0 GiB'
  const gpu = 'GPU NVIDIA GeForce RTX 4090 13%'
  const extra = ['load 1.47 1.80 2.17', 'up 1d 1h']
  const missing = 'unavailable: temperature (no readable sensor)'
  const line = (...parts: string[]): string => parts.join(' · ')
  // From the most detail to the least: the CPU model, load and uptime, sensors, GPU memory.
  const levels = [
    line(cpu, MODEL, ram, five, withVram, ...extra, missing),
    line(cpu, ram, five, withVram, ...extra, missing),
    line(cpu, ram, five, withVram, missing),
    line(cpu, ram, three, withVram, missing),
    line(cpu, ram, 'Sensor 0 70°', withVram, missing),
    line(cpu, ram, '70°C', withVram, missing),
    line(cpu, ram, '70°C', gpu, missing)
  ]
  /** What shows when `limit` is all there is: the first level that fits it. */
  const fit = (limit: number): string => formatTooltip(crowded, limit, limit)

  // Each level is what shows from its own length up to one short of the level before.
  levels.forEach((text, index) => {
    assert.equal(fit(text.length), text)
    if (index > 0) {
      assert.ok(text.length < levels[index - 1].length)
      assert.equal(fit(levels[index - 1].length - 1), text)
    }
  })

  // By default the first level short enough for most windows shows.
  assert.equal(formatTooltip(crowded), levels[4])
  // With more to say than that allows, the first level Orca still accepts shows, whole.
  const more = `unavailable: ${missing.replace('unavailable: ', '')}, ${'a'.repeat(48)}`
  const noisy = snapshot({ ...crowded, problems: ['temperature (no readable sensor)', 'a'.repeat(48)] })
  assert.ok(line(cpu, ram, '70°C', gpu, more).length > 180)
  assert.equal(formatTooltip(noisy), line(cpu, ram, three, withVram, more))
  // And when even the least is past what Orca accepts, that is cut short with an ellipsis.
  const cut = fit(100)
  assert.ok(cut.length <= 100)
  assert.ok(cut.startsWith('CPU 12.4%'))
  assert.ok(cut.endsWith('…'))
})

test('nothing the machine reports can push an update past what Orca accepts', () => {
  const huge: MetricsSnapshot = {
    cpu: { percent: 100, cores: 999_999 },
    memory: { usedBytes: 9e21, totalBytes: 9e21, percent: 100 },
    temperatures: Array.from({ length: 64 }, (_, index) => ({
      label: `${'s'.repeat(200)} ${index}`,
      celsius: 150
    })),
    gpu: { name: 'g'.repeat(200), utilization: 100, vramUsedBytes: 9e21, vramTotalBytes: 9e21 },
    cpuModel: 'm'.repeat(200),
    load: [999.999, 999.999, 999.999],
    uptimeSeconds: 1e12,
    problems: ['p'.repeat(200), 'q'.repeat(200), 'r'.repeat(200), 't'.repeat(200)],
    // Another machine with the longest names there can be.
    origin: { bar: 'b'.repeat(64), tooltip: 't'.repeat(256) }
  }
  const item = statusItemFor(huge, 'resources')
  assert.ok(item.text.length <= STATUS_TEXT_MAX)
  assert.ok(item.tooltip.length <= TOOLTIP_MAX)
  assert.equal(item.visible, true)
  assert.ok(item.text.startsWith('b'.repeat(13) + '… · CPU 100%'))
})

test('raises the tone only near the limits', () => {
  assert.equal(toneFor(snapshot()), 'neutral')
  assert.equal(toneFor(snapshot({ cpu: { percent: 75, cores: 4 } })), 'warning')
  assert.equal(
    toneFor(snapshot({ memory: { usedBytes: 29 * GIB, totalBytes: 31 * GIB, percent: 93.5 } })),
    'danger'
  )
  assert.equal(toneFor(snapshot({ temperatures: [{ label: 'Core', celsius: 85 }] })), 'danger')
  assert.equal(toneFor(snapshot({ cpu: { percent: 90, cores: 4 } })), 'danger')
  // What cannot be read is not a high reading.
  assert.equal(toneFor(snapshot({ cpu: null, memory: null, temperatures: [] })), 'neutral')
})

test('the whole update names the item and stays one line', () => {
  const item = statusItemFor(snapshot(), 'resources')
  assert.equal(item.id, 'resources')
  assert.equal(item.text, 'CPU 12% · RAM 2.0/8.0G · 63°C')
  assert.equal(item.tone, 'neutral')
  assert.ok(!item.tooltip.includes('\n'))
})

test('names the other machine a reading came from, first in the item and first in the tooltip', () => {
  assert.equal(formatStatusText(snapshot({ origin: ORIGIN })), 'my-server · CPU 12% · RAM 2.0/8.0G · 63°C')
  // The two names take the room the CPU model had: with them it comes to 193 characters.
  assert.equal(
    formatTooltip(snapshot({ origin: ORIGIN })),
    'example-project on my-server · CPU 12.4% (4 threads) · RAM 2.0/8.0 GiB (25%) · Sensor 1 63°, Core 62°, CPU 0 61° · load 1.47 1.80 2.17 · up 1d 1h'
  )
  const roomy = formatTooltip(snapshot({ origin: ORIGIN }), 400, 400)
  assert.ok(roomy.includes(MODEL))
  assert.equal(roomy.length, 193)
  const none = emptySnapshot(['waiting for the first reading'], ORIGIN)
  assert.equal(formatStatusText(none), 'my-server · No host stats')
  assert.equal(formatTooltip(none), 'example-project on my-server · unavailable: waiting for the first reading')
  assert.equal(none.cpu, null)
  assert.deepEqual(none.problems, ['waiting for the first reading'])
})

test('a reading of nothing has nothing in it and keeps its reasons', () => {
  const none = emptySnapshot(['CPU (not reported)'])
  assert.equal(none.origin, null)
  assert.deepEqual(none.temperatures, [])
  assert.equal(none.memory, null)
  assert.equal(none.gpu, null)
  assert.equal(formatStatusText(none), 'No host stats')
})

test('the tooltip keeps its level of detail from one reading to the next', () => {
  const crowded = snapshot({
    temperatures: Array.from({ length: 8 }, (_, index) => ({ label: `Sensor ${index}`, celsius: 70 - index })),
    gpu: nvidia,
    problems: ['temperature (no readable sensor)']
  })
  const plain = snapshot()
  // A budget the crowded reading only fits with three sensors, and the plain one with everything.
  const target = 210
  const sparse = formatTooltip(crowded, target, target)
  const full = formatTooltip(plain)
  assert.ok(sparse.includes(' +5 more'))
  assert.equal(formatTooltip(plain, target, target), full)
  const tooltip = createTooltipSelector({ settle: 3, target })
  /** Held back: the reading without its CPU model, load or uptime. */
  const isHeld = (line: string): boolean => !line.includes(MODEL) && !line.includes('load')

  assert.equal(tooltip(crowded), sparse)
  // More detail does not come back on the first reading with room for it, nor the second...
  assert.ok(isHeld(tooltip(plain)))
  assert.ok(isHeld(tooltip(plain)))
  // ...but on the third, and it stays while there is room.
  assert.equal(tooltip(plain), full)
  assert.equal(tooltip(plain), full)
  // Less room means less detail at once, to stay within the budget.
  assert.equal(tooltip(crowded), sparse)
  // A level that only fits now and then does not flip the tooltip: it takes three readings in a row.
  assert.ok(isHeld(tooltip(plain)))
  assert.equal(tooltip(crowded), sparse)
  assert.ok(isHeld(tooltip(plain)))
  assert.ok(isHeld(tooltip(plain)))
  assert.equal(tooltip(plain), full)
  // A new source of readings starts over.
  tooltip.reset?.()
  assert.equal(tooltip(plain), full)
  // Left to itself, more detail waits for eight readings in a row that have room for it.
  const byItself = createTooltipSelector({ target })
  assert.equal(byItself(crowded), sparse)
  for (let reading = 0; reading < 7; reading++) {
    assert.ok(isHeld(byItself(plain)))
  }
  assert.equal(byItself(plain), full)
})

test('reads macOS memory from vm_stat', () => {
  // Made-up page counts, in the shape vm_stat prints them.
  const stat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               50000.',
    'Pages active:                             60000.',
    'Pages inactive:                           40000.',
    'Pages wired down:                         20000.',
    'Pages purgeable:                           5000.',
    'File-backed pages:                        30000.',
    'Anonymous pages:                          45000.',
    'Pages stored in compressor:               10000.',
    'Pages occupied by compressor:              5000.'
  ].join('\n')
  // Anonymous, wired and the compressor's pages; what the compressor holds is not counted twice.
  assert.deepEqual(parseVmStat(stat), { pageSize: 16384, usedPages: 45000 + 20000 + 5000 })
  // Without anonymous pages, active ones stand in for them.
  const older = stat.replace('Anonymous pages:', 'Pages anonymous:').replace('Pages anonymous:', 'Pages none:')
  assert.deepEqual(parseVmStat(older), { pageSize: 16384, usedPages: 60000 + 20000 + 5000 })
  assert.equal(parseVmStat('Pages free: 10.'), null)
  assert.equal(parseVmStat(''), null)
  assert.equal(parseMemsize('4294967296\n'), 4294967296)
  assert.equal(parseMemsize('unknown: 0'), null)
})
