// The command the remote mode runs on the measured machine: what it must look like to be sent
// safely, and what it prints when it is really run, with nothing but `sleep` to call and with an
// nvidia-smi that answers, hangs or fails.

import { execFile, execFileSync } from 'node:child_process'
import { accessSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { formatStatusText } from './metrics'
import { STATS_MARKER, STATS_TITLE, sampleSecondsFor, statsCommand } from './stats-command'
import { parseStatsLines, statsLineToSnapshot, type StatsLine } from './stats-line'

const ON_LINUX = process.platform === 'linux'
const ON_WINDOWS = process.platform === 'win32'
/** `exec sh -c '` before the script and `'` after it. */
const WRAP_START = "exec sh -c '"

test('the stats command is one line of sh in single quotes, with nothing but whole numbers from the settings', () => {
  for (const refreshSeconds of [1, 2, 5, 30, 60]) {
    const command = statsCommand({ refreshSeconds })
    assert.ok(command.startsWith(WRAP_START))
    assert.ok(command.endsWith("'"))
    assert.equal(command.split('\n').length, 1)
    // Only the two that wrap it: the script is quoted with nothing to escape inside.
    assert.equal(command.split("'").length, 3)
    assert.ok(command.length < 4096, `${command.length} characters`)
    // Built from two pieces, so the command itself never holds what its lines start with: echoed,
    // it is not mistaken for a reading.
    assert.ok(!command.includes(STATS_MARKER))
    assert.ok(!command.includes(STATS_TITLE))
    assert.equal(parseStatsLines([command]), null)
  }
  // Only whole seconds reach the script, whatever the setting holds.
  assert.ok(!statsCommand({ refreshSeconds: 2.7 }).includes('2.7'))
  assert.ok(!statsCommand({ refreshSeconds: Number.NaN }).includes('NaN'))
  assert.ok(!statsCommand({ refreshSeconds: Infinity }).includes('Infinity'))
  for (const odd of [2.7, Number.NaN, Infinity, -1, 0]) {
    assert.ok(statsCommand({ refreshSeconds: odd }).includes(`; i=${sampleSecondsFor(odd)};`))
  }
  assert.ok(statsCommand({ refreshSeconds: 5 }).includes('; i=1; k=30;'))
  assert.ok(statsCommand({ refreshSeconds: 60 }).includes('; i=5; k=6;'))
})

test('the script samples a third of the reading interval at the most, and at least every five seconds', () => {
  assert.equal(sampleSecondsFor(1), 1)
  assert.equal(sampleSecondsFor(5), 1)
  assert.equal(sampleSecondsFor(8), 2)
  assert.equal(sampleSecondsFor(9), 3)
  assert.equal(sampleSecondsFor(15), 5)
  assert.equal(sampleSecondsFor(60), 5)
  // Nothing usable is a short interval, so a reading is never long out of date.
  assert.equal(sampleSecondsFor(Number.NaN), 1)
  assert.equal(sampleSecondsFor(Infinity), 1)
  assert.equal(sampleSecondsFor(0), 1)
  assert.equal(sampleSecondsFor(-5), 1)
  assert.equal(sampleSecondsFor(5.9), 2)
})

/** Registers a test of the script as it really runs: on a POSIX host only, since that is where it runs. */
const posixTest = (name: string, fn: () => unknown): void => {
  if (!ON_WINDOWS) {
    test(name, fn)
  }
}

/** Where the machine's `sleep` and `sh` are, which the stand-ins name by their full paths. */
const REAL_SLEEP = ON_WINDOWS ? '' : execFileSync('/bin/sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim()
const REAL_SH = ON_WINDOWS ? '' : execFileSync('/bin/sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim()

const exists = (file: string): boolean => {
  try {
    accessSync(file)
    return true
  } catch {
    return false
  }
}

/** The script without the `exec sh -c '…'` it is sent in, for running under another shell. */
const scriptOf = (refreshSeconds: number): string => statsCommand({ refreshSeconds }).slice(WRAP_START.length, -1)

type Printed = { stdout: string; stderr: string }

/** Runs something for `ms` and returns what it printed; the process is killed when the time is up. */
const runFor = (file: string, args: readonly string[], ms: number, bin: string): Promise<Printed> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: ms, killSignal: 'SIGKILL', env: { PATH: bin }, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        // The kill that ends the run is the one failure expected.
        if (error && error.killed !== true) {
          reject(error)
        } else {
          resolve({ stdout, stderr })
        }
      }
    )
  })

/** The readings in what a run printed, and whatever else it printed. */
function readingsOf(stdout: string): { records: StatsLine[]; other: string[] } {
  const records: StatsLine[] = []
  const other: string[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') {
      continue
    }
    const record = parseStatsLines([line])
    if (record) {
      records.push(record)
    } else {
      other.push(line)
    }
  }
  return { records, other }
}

/** The non-empty lines of a text. */
const linesOf = (text: string): string[] => text.split('\n').filter((line) => line !== '')

/**
 * What a run must print when nothing is in its way: readings numbered one after another, each
 * with every metric the machine has, and nothing else. Answers the readings.
 */
function steadyReadings(printed: Printed, atLeast = 5): StatsLine[] {
  assert.equal(printed.stderr, '')
  const { records, other } = readingsOf(printed.stdout)
  assert.deepEqual(other, [])
  assert.ok(records.length >= atLeast, `${records.length} readings`)
  assert.deepEqual(
    records.map((record) => record.seq),
    records.map((_, index) => index + 1)
  )
  if (!ON_LINUX) {
    // The script reads /proc and /sys: on another system it has nothing to report, and says so.
    const nothing = { cpuTenths: null, cores: null, memTotalKb: null, memUsedKb: null, temps: [], load: null, uptimeSeconds: null, model: null, gpu: null }
    for (const record of records) {
      assert.deepEqual(record, { ...nothing, seq: record.seq })
      assert.deepEqual(statsLineToSnapshot(record, null).problems, [
        'CPU (not reported)',
        'RAM (not reported)',
        'temperature (no readable sensor)'
      ])
    }
    return records
  }
  const thermal = exists('/sys/class/thermal/thermal_zone0/temp')
  const model = readFileSync('/proc/cpuinfo', 'utf8').includes('model name')
  for (const [index, record] of records.entries()) {
    // The first reading needs a second before it, which the script takes before its first line.
    if (index === 0) {
      continue
    }
    assert.ok(record.cpuTenths !== null && record.cpuTenths <= 1000)
    assert.ok(record.cores !== null && record.cores >= 1)
    assert.ok(record.memTotalKb !== null && record.memUsedKb !== null && record.memUsedKb <= record.memTotalKb)
    assert.deepEqual(record.load === null ? null : record.load.length, 3)
    assert.ok(record.uptimeSeconds !== null && record.uptimeSeconds > 0)
    assert.equal(record.temps.length > 0, thermal, 'a thermal zone where the machine has one')
    assert.equal(record.model !== null, model, 'the CPU model where /proc/cpuinfo names it')
  }
  return records
}

/**
 * A folder that is the script's whole PATH: the `sh` the command starts, a `sleep` that takes a
 * fiftieth of the time asked for its one second, so a run takes a moment rather than a minute,
 * and when given one an `nvidia-smi` made from what `nvidiaSmi` returns for the path of a file to
 * note its calls in. Anything else the script called would not be found.
 */
async function withStandIns(
  nvidiaSmi: null | ((calls: string) => string),
  run: (bin: string, calls: string, sleeps: string) => Promise<void>
): Promise<void> {
  const bin = await mkdtemp(join(tmpdir(), 'server-stats-bin-'))
  const calls = join(bin, 'calls')
  const sleeps = join(bin, 'sleeps')
  try {
    await writeFile(
      join(bin, 'sleep'),
      [
        '#!/bin/sh',
        // What was asked for is noted, so a test can count the waits.
        "printf '%s\\n' \"${1:-}\" >> '" + sleeps + "'",
        '[ "${1:-}" = 1 ] && exec ' + REAL_SLEEP + ' 0.02',
        `exec ${REAL_SLEEP} "$@"`,
        ''
      ].join('\n')
    )
    await chmod(join(bin, 'sleep'), 0o755)
    await symlink(REAL_SH, join(bin, 'sh'))
    if (nvidiaSmi !== null) {
      await writeFile(join(bin, 'nvidia-smi'), `#!/bin/sh\n${nvidiaSmi(calls)}`)
      await chmod(join(bin, 'nvidia-smi'), 0o755)
    }
    await run(bin, calls, sleeps)
  } finally {
    await rm(bin, { recursive: true, force: true })
  }
}

posixTest('run as it is sent, the script prints one reading after another and nothing else', async () => {
  await withStandIns(null, async (bin) => {
    const printed = await runFor('/bin/sh', ['-c', statsCommand({ refreshSeconds: 5 })], 450, bin)
    const records = steadyReadings(printed)
    if (ON_LINUX) {
      const item = formatStatusText(statsLineToSnapshot(records[records.length - 1], null))
      assert.match(item, /^CPU \d+% · RAM [\d.]+\/[\d.]+G( · \d+°C)?$/)
      // Memory as the machine itself reports it, give or take what moves in the moment.
      const meminfo = readFileSync('/proc/meminfo', 'utf8')
      const kilobytes = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1])
      const last = records[records.length - 1]
      assert.equal(last.memTotalKb, kilobytes('MemTotal'))
      assert.ok(last.memUsedKb !== null && Math.abs(last.memUsedKb - (kilobytes('MemTotal') - kilobytes('MemAvailable'))) < kilobytes('MemTotal') * 0.05)
    }
  })
})

/**
 * Other POSIX shells the machine may have, since `sh` is one of them on other machines, and how
 * long a run under each needs. busybox has a `sleep` of its own, whatever the PATH says, so there
 * a reading takes the script's whole second.
 */
const OTHER_SHELLS: readonly [string, readonly string[], number][] = [
  ['/bin/bash', ['--posix'], 450],
  ['/bin/zsh', ['--emulate', 'sh'], 450],
  ['/usr/bin/busybox', ['sh'], 2_200]
]

posixTest('the script runs the same under other POSIX shells', async () => {
  await withStandIns(null, async (bin) => {
    for (const [shell, options, ms] of OTHER_SHELLS.filter(([shell]) => exists(shell))) {
      steadyReadings(await runFor(shell, [...options, '-c', scriptOf(5)], ms, bin), ms >= 2_000 ? 2 : 5)
    }
  })
})

/** Which ask of nvidia-smi a reading's GPU came from: the first sample starts one, and every thirtieth after. */
const askUpTo = (seq: number): number => Math.floor((seq - 1) / 30) + 1

/**
 * A stand-in nvidia-smi that counts its calls in a file and prints the count as the GPU's use,
 * so each reading says which ask its GPU came from. Shell builtins only, since the PATH has nothing.
 */
const countsCalls = (calls: string): string =>
  [
    `read -r n < '${calls}' 2> /dev/null`,
    `printf '%s\\n' "$((\${n:-0} + 1))" > '${calls}'`,
    `printf 'NVIDIA GeForce RTX 4090, %s, 1234, 24564\\n' "$((\${n:-0} + 1))"`
  ].join('\n')

posixTest('with an NVIDIA GPU every reading has it, from nvidia-smi once in thirty seconds', async () => {
  await withStandIns(countsCalls, async (bin) => {
    // A reading every 3 seconds: the script samples every second, and asks on the first sample and every thirtieth after.
    const printed = await runFor('/bin/sh', ['-c', statsCommand({ refreshSeconds: 3 })], 1_400, bin)
    const records = steadyReadings(printed)
    assert.ok(records.length >= 32, `${records.length} readings`)
    for (const record of records) {
      assert.deepEqual(
        record.gpu,
        { name: 'NVIDIA GeForce RTX 4090', utilization: askUpTo(record.seq), vramUsedMib: 1234, vramTotalMib: 24564 },
        `reading ${record.seq}`
      )
    }
  })
})

posixTest('an nvidia-smi that hangs is killed after five seconds, and the readings go on without the GPU', async () => {
  await withStandIns(
    (calls) => `printf '%s\\n' "$$" > '${calls}'\nexec sleep 60`,
    async (bin, calls, sleeps) => {
      const printed = await runFor('/bin/sh', ['-c', statsCommand({ refreshSeconds: 3 })], 1_200, bin)
      const records = steadyReadings(printed)
      const asked = linesOf(await readFile(calls, 'utf8'))
      // Asked once: ten times less often after a hang, which this run does not reach.
      assert.deepEqual(asked.length, 1)
      for (const record of records) {
        assert.equal(record.gpu, null)
      }
      assert.throws(() => process.kill(Number(asked[0]), 0))
      // Five seconds went by first, one sleep at a time: the script's own, the five waits, and one
      // between readings (the last of which may or may not have been asked for when the run ended).
      // The hung stand-in's own `sleep 60` is in the log too.
      const waited = linesOf(await readFile(sleeps, 'utf8'))
      const seconds = waited.filter((asked) => asked === '1').length - records.length
      assert.ok(seconds === 5 || seconds === 6, `${waited.join(' ')} for ${records.length} readings`)
    }
  )
})

posixTest('a failing nvidia-smi leaves the GPU out, says nothing about it, and is asked again later', async () => {
  await withStandIns(
    (calls) => `${countsCalls(calls)}\necho 'NVIDIA-SMI has failed' >&2\nexit 9`,
    async (bin, calls) => {
      const printed = await runFor('/bin/sh', ['-c', statsCommand({ refreshSeconds: 3 })], 1_400, bin)
      const records = steadyReadings(printed)
      assert.ok(records.length >= 32, `${records.length} readings`)
      for (const record of records) {
        assert.equal(record.gpu, null)
      }
      // Asked on the first sample and every thirtieth after, though it failed every time.
      const asked = Number(await readFile(calls, 'utf8'))
      assert.ok(asked >= 2 && asked <= askUpTo(records.length) + 1, `asked ${asked} times in ${records.length} readings`)
    }
  )
})

posixTest('what nvidia-smi prints that is not one GPU line makes no GPU in the reading', async () => {
  for (const answer of [
    "printf 'NVIDIA-SMI has failed\\n'",
    "printf 'Tesla T4, [N/A], 1, 2\\n'",
    "printf 'NVIDIA \"Gamers\" GPU, 5, 1, 2\\n'"
  ]) {
    await withStandIns(() => `${answer}\n`, async (bin) => {
      const printed = await runFor('/bin/sh', ['-c', statsCommand({ refreshSeconds: 3 })], 350, bin)
      for (const record of steadyReadings(printed, 3)) {
        assert.equal(record.gpu, null, answer)
      }
    })
  }
})
