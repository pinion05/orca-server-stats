// ./system.ts against a folder of fake `/proc` and `/sys` files and a `nvidia-smi` that answers
// from the test, so these tests read no real sensor and pass on any host.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assert, test } from 'orca/testing'
import { SENSOR_LABEL_MAX } from './metrics'
import {
  cpuFacts,
  createSystemReader,
  failureReason,
  type CommandRunner,
  type Reading,
  type SystemReader,
  type SystemReaderOptions
} from './system'

const MIB = 1024 ** 2
const SECOND = 1000
const MINUTE = 60 * SECOND
const NVIDIA_QUERY = [
  'nvidia-smi',
  '--query-gpu=name,utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits'
]

/**
 * A folder of fake system files, removed again afterwards. `/sys/class` entries are symlinks on a
 * real machine, so a value `-> path` makes one, to `path` inside the folder; `null` makes a file
 * that exists but cannot be read.
 */
async function withFixture(
  files: Record<string, string | null>,
  run: (root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'server-stats-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const file = join(root, path)
      await mkdir(dirname(file), { recursive: true })
      if (content === null || content.startsWith('-> ')) {
        await symlink(content === null ? join(root, 'nothing-here') : join(root, content.slice(3)), file)
      } else {
        await writeFile(file, content)
      }
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

type FixtureOptions = Omit<SystemReaderOptions, 'procRoot' | 'sysRoot'>

/** A Linux reader over a fixture's `/proc` and `/sys`, with no `nvidia-smi` unless the test gives one. */
const linuxReader = (root: string, options: FixtureOptions = {}): SystemReader =>
  createSystemReader({
    platform: 'linux',
    run: async () => {
      throw noNvidiaSmi()
    },
    ...options,
    procRoot: join(root, 'proc'),
    sysRoot: join(root, 'sys')
  })

const noNvidiaSmi = (): Error => Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' })

/** A `nvidia-smi` the test scripts: each call takes the next answer, or the last one again. */
function scriptedNvidia(answers: Array<string | Error>): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args])
      const answer = answers[Math.min(calls.length, answers.length) - 1]
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    }
  }
}

test('reads CPU time and memory from /proc on Linux', async () => {
  await withFixture(
    {
      'proc/stat': 'cpu  100 0 100 800 0 0 0 0\ncpu0 1 2 3 4 5 6 7 8\n',
      'proc/meminfo':
        'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4000000 kB\n'
    },
    async (root) => {
      const reader = linuxReader(root)
      assert.deepEqual(await reader.cpuTimes(), { value: { total: 1000, idle: 800 }, problem: null })
      assert.deepEqual(await reader.memory(0), {
        value: { usedBytes: 12_000_000 * 1024, totalBytes: 16_000_000 * 1024, percent: 75 },
        problem: null
      })
    }
  )
})

test('falls back to the counters Node reports where /proc is missing', async () => {
  await withFixture({}, async (root) => {
    const reader = linuxReader(root)
    assert.ok((await reader.cpuTimes()).value)
    assert.deepEqual(await reader.memory(0), { value: null, problem: 'RAM (/proc/meminfo unreadable)' })
    // No /sys either: no sensor to read, which the tooltip should say.
    assert.deepEqual(await reader.temperatures(0), {
      value: [],
      problem: 'temperature (no readable sensor)'
    })
  })
})

test('reads hwmon sensors behind the symlinks of /sys/class, naming and sorting them', async () => {
  await withFixture(
    {
      'sys/class/hwmon/hwmon0': '-> devices/soc0',
      'devices/soc0/name': 'soc0\n',
      'devices/soc0/temp1_input': '45000',
      'devices/soc0/temp1_label': 'CPU 0\n',
      'sys/class/hwmon/hwmon1': '-> devices/board',
      'devices/board/name': 'board\n',
      'devices/board/temp1_input': '61000',
      'devices/board/temp1_label': 'CPU',
      // A sensor the driver lists but cannot answer.
      'devices/board/temp2_input': null,
      'devices/board/temp2_label': 'GPU',
      // No label of its own: the chip names it.
      'devices/board/temp3_input': '61000',
      // A sensor with nothing to report is skipped, never shown as 0 °C.
      'devices/board/temp4_input': '0',
      'devices/board/temp10_input': '55000',
      'devices/board/temp10_label': 'temp10',
      'sys/class/hwmon/hwmon2': '-> devices/nvme',
      'devices/nvme/name': 'nvme\n',
      'devices/nvme/temp1_input': '57850',
      'devices/nvme/temp1_label': 'Composite',
      // Not a temperature.
      'devices/nvme/in0_input': '1200'
    },
    async (root) => {
      assert.deepEqual(await linuxReader(root).temperatures(0), {
        value: [
          { label: 'CPU', celsius: 61 },
          { label: 'board temp3', celsius: 61 },
          { label: 'Composite', celsius: 57.9 },
          { label: 'board temp10', celsius: 55 },
          { label: 'CPU 0', celsius: 45 }
        ],
        problem: null
      })
    }
  )
})

test('tells sensors with the same label apart, and keeps a label short and clean', async () => {
  const noisy = `\u0000${'x'.repeat(40)}\t#${'y'.repeat(20)}\n`
  await withFixture(
    {
      'sys/class/hwmon/hwmon0': '-> devices/coretemp',
      'devices/coretemp/name': 'coretemp\n',
      'devices/coretemp/temp1_input': '60000',
      'devices/coretemp/temp1_label': 'CPU',
      'sys/class/hwmon/hwmon1': '-> devices/acpitz',
      'devices/acpitz/name': 'acpitz\n',
      'devices/acpitz/temp1_input': '40000',
      'devices/acpitz/temp1_label': 'CPU',
      'sys/class/hwmon/hwmon2': '-> devices/odd',
      'devices/odd/name': 'odd\n',
      'devices/odd/temp1_input': '30000',
      'devices/odd/temp1_label': noisy
    },
    async (root) => {
      const { value } = await linuxReader(root).temperatures(0)
      assert.deepEqual(
        value.map((reading) => `${reading.label} ${reading.celsius}`),
        ['CPU (coretemp) 60', 'CPU (acpitz) 40', `${'x'.repeat(23)}… 30`]
      )
      assert.ok(value.every((reading) => reading.label.length <= SENSOR_LABEL_MAX))
    }
  )
})

test('falls back to ACPI thermal zones when hwmon has no temperature', async () => {
  await withFixture(
    {
      'sys/class/hwmon/hwmon0': '-> devices/fan',
      'devices/fan/name': 'acpi_fan\n',
      'devices/fan/fan1_input': '4367\n',
      'sys/class/thermal/cooling_device0': '-> devices/fan',
      'sys/class/thermal/thermal_zone0': '-> devices/zone0',
      'devices/zone0/type': 'cpu-thermal\n',
      'devices/zone0/temp': '48000\n',
      'sys/class/thermal/thermal_zone1': '-> devices/zone1',
      'devices/zone1/type': 'wl0-thermal\n',
      'devices/zone1/temp': '52000\n'
    },
    async (root) => {
      assert.deepEqual(await linuxReader(root).temperatures(0), {
        value: [
          { label: 'wl0-thermal', celsius: 52 },
          { label: 'cpu-thermal', celsius: 48 }
        ],
        problem: null
      })
    }
  )
})

test('lists sensors again now and then, so one that appears later is picked up', async () => {
  const start = 1_000_000
  await withFixture(
    {
      'sys/class/hwmon/hwmon0': '-> devices/nvme',
      'devices/nvme/name': 'nvme\n',
      'devices/nvme/temp1_input': '40000'
    },
    async (root) => {
      const reader = linuxReader(root)
      assert.equal((await reader.temperatures(start)).value.length, 1)
      await writeFile(join(root, 'devices/nvme/temp2_input'), '50000')
      // Within a minute the old list stands; after it the folder is read again.
      assert.equal((await reader.temperatures(start + 30 * SECOND)).value.length, 1)
      const later = await reader.temperatures(start + MINUTE)
      assert.deepEqual(
        later.value.map((reading) => reading.label),
        ['nvme temp2', 'nvme temp1']
      )
    }
  )
})

test('reads sensors every five seconds, and keeps the last reading in between', async () => {
  const start = 1_000_000
  const input = join('sys', 'class', 'hwmon', 'hwmon0')
  await withFixture(
    {
      [input]: '-> devices/nvme',
      'devices/nvme/name': 'nvme\n',
      'devices/nvme/temp1_input': '40000'
    },
    async (root) => {
      const reader = linuxReader(root)
      assert.equal((await reader.temperatures(start)).value[0]?.celsius, 40)
      await writeFile(join(root, 'devices/nvme/temp1_input'), '45000')
      // Within five seconds the old reading stands; after it the sensor is read again.
      assert.equal((await reader.temperatures(start + 4 * SECOND)).value[0]?.celsius, 40)
      assert.equal((await reader.temperatures(start + 5 * SECOND)).value[0]?.celsius, 45)
    }
  )
})

test('a sensor that keeps failing is left alone until the next scan', async () => {
  const start = 1_000_000
  const stuck = 'devices/nvme/temp2_input'
  await withFixture(
    {
      'sys/class/hwmon/hwmon0': '-> devices/nvme',
      'devices/nvme/name': 'nvme\n',
      'devices/nvme/temp1_input': '40000',
      [stuck]: null
    },
    async (root) => {
      const reader = linuxReader(root)
      const at = async (offset: number): Promise<string[]> =>
        (await reader.temperatures(start + offset)).value.map((reading) => `${reading.label} ${reading.celsius}`)
      assert.deepEqual(await at(0), ['nvme temp1 40'])
      // It fails three readings in a row, then starts answering.
      await at(5 * SECOND)
      await at(10 * SECOND)
      await rm(join(root, stuck))
      await writeFile(join(root, stuck), '50000')
      // Not asked again before the minute is up, so the answer is not seen yet.
      assert.deepEqual(await at(15 * SECOND), ['nvme temp1 40'])
      assert.deepEqual(await at(MINUTE), ['nvme temp2 50', 'nvme temp1 40'])
    }
  )
})

test('reads an AMD or Intel GPU from sysfs, skipping cards that report no use', async () => {
  await withFixture(
    {
      'sys/class/drm/version': 'drm 1.1.0\n',
      'sys/class/drm/card0': '-> devices/evdi',
      'devices/evdi/device/uevent': 'DRIVER=evdi\n',
      'sys/class/drm/card1': '-> devices/amdgpu',
      'devices/amdgpu/device/uevent': 'DRIVER=amdgpu\nPCI_ID=1002:0000\n',
      'devices/amdgpu/device/gpu_busy_percent': '7\n',
      'devices/amdgpu/device/mem_info_vram_used': `${926 * MIB}\n`,
      'devices/amdgpu/device/mem_info_vram_total': `${1.5 * MIB * 1024}\n`,
      'sys/class/drm/card2': '-> devices/other',
      'devices/other/device/gpu_busy_percent': '99\n',
      // A connector, not a card.
      'sys/class/drm/card1-DP-1': '-> devices/connector',
      'devices/connector/status': 'connected\n'
    },
    async (root) => {
      assert.deepEqual(await linuxReader(root).gpu(0), {
        value: {
          name: 'amdgpu',
          utilization: 7,
          vramUsedBytes: 926 * MIB,
          vramTotalBytes: 1.5 * MIB * 1024
        },
        problem: null
      })
    }
  )
})

test('a GPU without memory counters shows its use and no memory; no GPU is no problem', async () => {
  await withFixture(
    {
      'sys/class/drm/card0': '-> devices/intel',
      'devices/intel/device/uevent': 'DRIVER=i915\n',
      'devices/intel/device/gpu_busy_percent': '12\n'
    },
    async (root) => {
      assert.deepEqual(await linuxReader(root).gpu(0), {
        value: { name: 'i915', utilization: 12, vramUsedBytes: null, vramTotalBytes: null },
        problem: null
      })
    }
  )
  await withFixture({}, async (root) => {
    assert.deepEqual(await linuxReader(root).gpu(0), { value: null, problem: null })
  })
})

test('nvidia-smi runs at most every thirty seconds and its last answer shows in between', async () => {
  const nvidia = scriptedNvidia(['NVIDIA GeForce RTX 4090, 12, 1234, 24564\n'])
  await withFixture({}, async (root) => {
    const reader = linuxReader(root, { run: nvidia.run })
    const first = await reader.gpu(0)
    assert.deepEqual(first, {
      value: {
        name: 'NVIDIA GeForce RTX 4090',
        utilization: 12,
        vramUsedBytes: 1234 * MIB,
        vramTotalBytes: 24564 * MIB
      },
      problem: null
    })
    assert.deepEqual(await reader.gpu(29 * SECOND), first)
    assert.equal(nvidia.calls.length, 1)
    await reader.gpu(30 * SECOND)
  })
  assert.deepEqual(nvidia.calls, [NVIDIA_QUERY, NVIDIA_QUERY])
})

test('a failing nvidia-smi hides the GPU, says why, and is tried again later', async () => {
  const broken = Object.assign(new Error('NVIDIA-SMI has failed'), { code: 9 })
  const nvidia = scriptedNvidia(['RTX 4090, 5, 1, 2', broken, 'RTX 4090, 6, 1, 2'])
  await withFixture({}, async (root) => {
    const reader = linuxReader(root, { run: nvidia.run })
    assert.equal((await reader.gpu(0)).value?.utilization, 5)
    assert.deepEqual(await reader.gpu(30 * SECOND), { value: null, problem: 'nvidia-smi (exit 9)' })
    // The same failure a second later is neither asked again nor reported twice.
    assert.deepEqual(await reader.gpu(31 * SECOND), { value: null, problem: null })
    assert.equal(nvidia.calls.length, 2)
    assert.equal((await reader.gpu(60 * SECOND)).value?.utilization, 6)
  })
})

test('a host without nvidia-smi is left alone, and asked again minutes later', async () => {
  const nvidia = scriptedNvidia([noNvidiaSmi(), 'RTX 4090, 3, 1, 2'])
  await withFixture({}, async (root) => {
    const reader = linuxReader(root, { run: nvidia.run })
    // No NVIDIA driver is normal, so it is not reported as a failure.
    assert.deepEqual(await reader.gpu(0), { value: null, problem: null })
    await reader.gpu(4 * MINUTE)
    assert.equal(nvidia.calls.length, 1)
    assert.equal((await reader.gpu(5 * MINUTE)).value?.utilization, 3)
  })
})

test('an nvidia-smi that reports no GPU is not asked again soon', async () => {
  const nvidia = scriptedNvidia(['GPU, [N/A], 1, 2'])
  await withFixture({}, async (root) => {
    const reader = linuxReader(root, { run: nvidia.run })
    assert.deepEqual(await reader.gpu(0), { value: null, problem: 'nvidia-smi (no GPU in its output)' })
    // Minutes later, not every thirty seconds: each run is a process.
    assert.deepEqual(await reader.gpu(4 * MINUTE), { value: null, problem: null })
    assert.equal(nvidia.calls.length, 1)
    await reader.gpu(5 * MINUTE)
    assert.equal(nvidia.calls.length, 2)
  })
})

test('a failing nvidia-smi does not hide an AMD GPU that sysfs can read', async () => {
  const nvidia = scriptedNvidia([Object.assign(new Error('failed'), { code: 9 })])
  await withFixture(
    {
      'sys/class/drm/card0': '-> devices/amdgpu',
      'devices/amdgpu/device/uevent': 'DRIVER=amdgpu\n',
      'devices/amdgpu/device/gpu_busy_percent': '40\n'
    },
    async (root) => {
      const gpu = await linuxReader(root, { run: nvidia.run }).gpu(0)
      assert.equal(gpu.value?.name, 'amdgpu')
      assert.equal(gpu.problem, null)
    }
  )
})

/**
 * What a Mac with 8 GiB answers to the two commands its memory is read with, its page counts made
 * up; `fail` makes `vm_stat` fail.
 */
const MAC_MEMORY = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                50000.',
  'Pages active:                              60000.',
  'Pages inactive:                            40000.',
  'Pages wired down:                          20000.',
  'Anonymous pages:                           45000.',
  'Pages stored in compressor:                10000.',
  'Pages occupied by compressor:               5000.'
].join('\n')

function macCommands(fail = false): CommandRunner & { commands: string[] } {
  const commands: string[] = []
  const run = async (command: string): Promise<string> => {
    commands.push(command)
    if (command === '/usr/sbin/sysctl') {
      return '8589934592\n'
    }
    if (command === '/usr/vm_stat' && !fail) {
      return MAC_MEMORY
    }
    throw Object.assign(new Error('not on this machine'), { code: 'ENOENT' })
  }
  run.commands = commands
  return run
}

test('macOS and Windows get what Node reports, and nothing is guessed', async () => {
  const nvidia = scriptedNvidia(['RTX 4090, 3, 1, 2'])
  const mac = macCommands()
  // The fixture has /proc and /sys files: a Mac or a PC must not read them.
  const files = {
    'proc/stat': 'cpu  100 0 100 800 0 0 0 0\n',
    'proc/meminfo': 'MemTotal: 16000000 kB\nMemAvailable: 4000000 kB\n',
    'sys/class/hwmon/hwmon0': '-> devices/soc0',
    'devices/soc0/name': 'soc0\n',
    'devices/soc0/temp1_input': '45000',
    'sys/class/drm/card0': '-> devices/amdgpu',
    'devices/amdgpu/device/gpu_busy_percent': '7\n'
  }
  await withFixture(files, async (root) => {
    const other = (platform: string, run: CommandRunner): SystemReader =>
      createSystemReader({ platform, run, procRoot: join(root, 'proc'), sysRoot: join(root, 'sys') })

    const macReader = other('darwin', mac)
    assert.ok((await macReader.cpuTimes()).value)
    // Node's "free" is only unused pages on a Mac, so sysctl and vm_stat are read instead.
    const memory = await macReader.memory(0)
    const pageSize = 16384
    // Anonymous, wired and the compressor's own pages: 1.07 GiB of the 8 GiB (524,288 pages).
    const usedPages = 45000 + 20000 + 5000
    assert.deepEqual(memory, {
      value: {
        usedBytes: usedPages * pageSize,
        totalBytes: 8589934592,
        percent: ((usedPages * pageSize) / 8589934592) * 100
      },
      problem: null
    })
    const used = memory.value
    assert.ok(used && used.usedBytes < used.totalBytes)
    assert.deepEqual(mac.commands, ['/usr/sbin/sysctl', '/usr/vm_stat'])
    // Two commands each time, so no more often than every five seconds.
    assert.deepEqual(await macReader.memory(4_000), memory)
    assert.equal(mac.commands.length, 2)
    await macReader.memory(5_000)
    assert.equal(mac.commands.length, 3)
    assert.deepEqual(await macReader.temperatures(0), { value: [], problem: null })
    assert.deepEqual(await macReader.gpu(0), { value: null, problem: null })
    assert.equal(nvidia.calls.length, 0)
    // Where vm_stat does not answer, memory is not shown rather than guessed.
    assert.deepEqual(await other('darwin', macCommands(true)).memory(0), {
      value: null,
      problem: 'RAM (not readable on macOS)'
    })

    const windows = other('win32', nvidia.run)
    const windowsMemory: Reading<unknown> = await windows.memory(0)
    assert.ok(windowsMemory.value)
    assert.equal(windowsMemory.problem, null)
    assert.deepEqual(await windows.temperatures(0), { value: [], problem: null })
    // Windows has nvidia-smi where a driver is installed.
    assert.equal((await windows.gpu(0)).value?.utilization, 3)
  })
})

test('nothing a reader hits makes it throw', async () => {
  await withFixture({}, async (root) => {
    const reader = linuxReader(root, {
      run: async () => {
        throw new Error('spawn failed')
      }
    })
    assert.ok((await reader.cpuTimes()).value)
    assert.equal((await reader.memory(0)).value, null)
    assert.deepEqual((await reader.temperatures(Number.NaN)).value, [])
    assert.deepEqual(await reader.gpu(Number.NaN), { value: null, problem: 'nvidia-smi (unreadable)' })
  })
})

test('says why a read failed', () => {
  assert.equal(failureReason(Object.assign(new Error('nope'), { code: 'EACCES' })), 'EACCES')
  assert.equal(failureReason(Object.assign(new Error('nope'), { code: 2 })), 'exit 2')
  assert.equal(failureReason(Object.assign(new Error('nope'), { killed: true })), 'timed out')
  assert.equal(failureReason(new Error('nope')), 'unreadable')
  assert.equal(failureReason(null), 'unreadable')
})

test('reads how many CPUs the machine has and what they are', () => {
  const facts = cpuFacts()
  assert.ok(facts.cores !== null && facts.cores > 0)
  assert.ok(facts.model === null || facts.model.length > 0)
})
