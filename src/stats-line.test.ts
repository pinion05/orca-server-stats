// What the stats script prints, read back from what a terminal holds: the newest whole line of
// the plugin's own among whatever else is there, checked field by field before it is shown.

import { assert, test } from 'orca/testing'
import { formatStatusText, formatTooltip, type Origin } from './metrics'
import { STATS_MARKER, statsCommand } from './stats-command'
import { parseStatsLines, plainLine, readStatsLine, statsLineToSnapshot } from './stats-line'

/** A made-up CPU model name, 45 characters: as long as a real one. */
const MODEL = 'Example CPU Model 000 w/ Example GPU Graphics'
const ORIGIN: Origin = { bar: 'my-server', tooltip: 'site on my-server' }

/**
 * One line as the script prints it, its values made up, numbered `seq`. `line(7)` comes to 210
 * characters and is kept there: a test below cuts that line into equal pieces, and whether the
 * pieces join back into JSON depends on where the cuts fall.
 */
const line = (seq: number, fields = ''): string =>
  `${STATS_MARKER}{"v":1,"seq":${seq},"cpu":123,"cores":4,"mem":[8388608,2097152],"temp":[{"t":"acpitz","c":63000}],"load":"10.00 20.00 30.00","up":1234567.89,"model":"${MODEL}"${fields}}`

/** What the script's JSON is without its marker. */
const json = (text: string): string => text.slice(STATS_MARKER.length)

test('a line as text, without what a terminal adds around it', () => {
  // Colours, and erases and cursor moves.
  assert.equal(plainLine('\u001b[32mcpu\u001b[0m\u001b[2K\u001b[1;2H'), 'cpu')
  assert.equal(plainLine('orca\u001b[?2004h-stats'), 'orca-stats')
  // Window titles, ended either way.
  assert.equal(plainLine('\u001b]0;title\u0007x\u001b]0;other\u001b\\y'), 'xy')
  // Carriage returns, as a Windows-style terminal writes.
  assert.equal(plainLine('a\r\nb\r'), 'a\nb')
  assert.equal(plainLine('plain'), 'plain')
})

test('the newest whole line of the plugin\'s own, among whatever else the terminal holds', () => {
  const tail = [
    '$ ping localhost',
    STATS_MARKER,
    'orca-server-stats is not JSON',
    line(3),
    'bash: warning: something',
    line(4),
    // Still being written: not a whole reading yet.
    `${STATS_MARKER}{"v":1,"seq":5,"cpu":12`
  ]
  assert.equal(parseStatsLines(tail)?.seq, 4)
  // A reading of another version of the script is not read.
  assert.equal(parseStatsLines([line(6), `${STATS_MARKER}{"v":2,"seq":7}`])?.seq, 6)
})

test('nothing of the plugin\'s own is nothing', () => {
  assert.equal(parseStatsLines([]), null)
  assert.equal(parseStatsLines(['']), null)
  assert.equal(parseStatsLines(['orca-server-stats']), null)
  assert.equal(parseStatsLines(['x' + line(1)]), null)
  // Built from two pieces, the command holds no line of its own even when a terminal echoes it.
  assert.equal(parseStatsLines([statsCommand({ refreshSeconds: 5 })]), null)
})

test('a line cut in two is put together again', () => {
  const whole = line(7)
  const at = whole.indexOf('"temp"')
  assert.equal(parseStatsLines([whole.slice(0, at), whole.slice(at)])?.seq, 7)
  // Up to four lines after a cut may complete it; past that it is left for the next reading.
  const cut = (count: number): string[] => {
    const size = Math.ceil(whole.length / count)
    return Array.from({ length: count }, (_, index) => whole.slice(index * size, (index + 1) * size))
  }
  assert.equal(parseStatsLines(cut(5))?.seq, 7)
  assert.equal(parseStatsLines(cut(6)), null)
})

test('a reading with room for what a terminal puts before it', () => {
  assert.equal(parseStatsLines(['  \u001b[?2004h' + line(8)])?.seq, 8)
  assert.equal(parseStatsLines([line(9) + '\r\n'])?.seq, 9)
})

/** What `line(54)` reads back as. */
const SAMPLE = {
  seq: 54,
  cpuTenths: 123,
  cores: 4,
  memTotalKb: 8388608,
  memUsedKb: 2097152,
  temps: [{ label: 'acpitz', milli: 63000 }],
  load: [10, 20, 30],
  uptimeSeconds: 1234567.89,
  model: MODEL,
  gpu: null
}

test('one line the script printed, field by field', () => {
  assert.deepEqual(readStatsLine(json(line(54))), SAMPLE)
  assert.deepEqual(
    readStatsLine(json(line(55, ',"gpu":"NVIDIA GeForce RTX 4090","gu":12,"vu":1234,"vt":24564'))),
    {
      ...SAMPLE,
      seq: 55,
      gpu: { name: 'NVIDIA GeForce RTX 4090', utilization: 12, vramUsedMib: 1234, vramTotalMib: 24564 }
    }
  )
})

test('a field that is not what it should be is nothing, and the rest of the line still is', () => {
  assert.deepEqual(
    readStatsLine(
      [
        '{"v":1,"seq":3,"cpu":-5,"cores":1.5,"mem":"none","up":-1,"model":"",',
        '"temp":[{"t":"","c":50000},{"t":"x","c":"hot"},{"t":"Package id 0","c":45000},{"c":44000}],',
        '"load":"1 2","gpu":"NVIDIA T4","gu":"fast","extra":true}'
      ].join('')
    ),
    {
      seq: 3,
      cpuTenths: null,
      cores: null,
      memTotalKb: null,
      memUsedKb: null,
      temps: [
        { label: 'zone', milli: 50000 },
        { label: 'Package id 0', milli: 45000 }
      ],
      load: null,
      uptimeSeconds: null,
      model: null,
      gpu: null
    }
  )
  // More CPU use than there is, a memory that is not two numbers, a GPU with no use to show.
  assert.equal(readStatsLine('{"v":1,"seq":1,"cpu":100001}')?.cpuTenths, null)
  assert.equal(readStatsLine('{"v":1,"seq":1,"mem":[1]}')?.memTotalKb, null)
  assert.equal(readStatsLine('{"v":1,"seq":1,"mem":[1,2,3]}')?.memUsedKb, null)
  assert.equal(readStatsLine('{"v":1,"seq":1,"gpu":"NVIDIA T4"}')?.gpu, null)
  assert.equal(readStatsLine('{"v":1,"seq":1,"gu":7}')?.gpu, null)
})

test('what is not a reading of this script is nothing', () => {
  for (const text of ['', 'null', '[]', '"text"', '42', '{"v":1}', '{"v":0,"seq":1}', '{"v":1,"seq":1.5}', '{"v":1,"seq":-1}', '{"v":1,"seq":"1"}']) {
    assert.equal(readStatsLine(text), null, text)
  }
})

test('words that came from the other machine are kept to one short line', () => {
  const record = readStatsLine(
    '{"v":1,"seq":1,"model":"  Example\\nCPU\\t9  ","temp":[{"t":"Package id 0\\u0007 sensor with a very long name indeed","c":45000},{"t":"","c":44000}],"gpu":" NVIDIA\\nT4 ","gu":120,"vu":0,"vt":0}'
  )
  assert.equal(record?.model, 'Example CPU 9')
  assert.deepEqual(record?.temps, [
    { label: 'Package id 0 sensor wit…', milli: 45000 },
    { label: 'zone', milli: 44000 }
  ])
  assert.deepEqual(record?.gpu, { name: 'NVIDIA T4', utilization: 100, vramUsedMib: 0, vramTotalMib: null })
  assert.equal(readStatsLine('{"v":1,"seq":1,"gpu":"","gu":3}')?.gpu?.name, 'GPU')
})

const KIB = 1024
const MIB = 1024 * KIB

/** The line as the script's own reading; a line that is not one fails the test. */
const reading = (text: string) => {
  const record = readStatsLine(text)
  assert.ok(record, text)
  return record
}

test('a reading becomes what the item shows, in the units it shows them in', () => {
  const snapshot = statsLineToSnapshot(reading(json(line(54))), ORIGIN)
  assert.deepEqual(snapshot, {
    cpu: { percent: 12.3, cores: 4 },
    memory: {
      usedBytes: 2097152 * KIB,
      totalBytes: 8388608 * KIB,
      percent: (2097152 / 8388608) * 100
    },
    temperatures: [{ label: 'acpitz', celsius: 63 }],
    gpu: null,
    cpuModel: MODEL,
    load: [10, 20, 30],
    uptimeSeconds: 1234567.89,
    problems: [],
    origin: ORIGIN
  })
  assert.equal(formatStatusText(snapshot), 'my-server · CPU 12% · RAM 2.0/8.0G · 63°C')
})

test('the hottest sensor first, GPU memory in bytes, and no sensor that has nothing to report', () => {
  const snapshot = statsLineToSnapshot(
    reading(
      '{"v":1,"seq":2,"cpu":400,"cores":8,"temp":[{"t":"acpitz","c":45000},{"t":"Core","c":74800},{"t":"x","c":0}],"gpu":"NVIDIA T4","gu":7,"vu":2048,"vt":16384}'
    ),
    null
  )
  assert.deepEqual(snapshot.temperatures, [
    { label: 'Core', celsius: 74.8 },
    { label: 'acpitz', celsius: 45 }
  ])
  assert.deepEqual(snapshot.gpu, {
    name: 'NVIDIA T4',
    utilization: 7,
    vramUsedBytes: 2048 * MIB,
    vramTotalBytes: 16384 * MIB
  })
  assert.equal(formatStatusText(snapshot), 'CPU 40% · 75°C · GPU 7%')
  // Without its memory, a GPU still has its use to show.
  assert.deepEqual(statsLineToSnapshot(reading('{"v":1,"seq":3,"gpu":"NVIDIA T4","gu":7}'), null).gpu, {
    name: 'NVIDIA T4',
    utilization: 7,
    vramUsedBytes: null,
    vramTotalBytes: null
  })
})

test('what the other machine did not report is said, since there is no telling why from here', () => {
  const snapshot = statsLineToSnapshot(reading('{"v":1,"seq":1}'), ORIGIN)
  assert.deepEqual(snapshot.problems, ['CPU (not reported)', 'RAM (not reported)', 'temperature (no readable sensor)'])
  assert.equal(formatStatusText(snapshot), 'my-server · No host stats')
  assert.equal(
    formatTooltip(snapshot),
    'site on my-server · unavailable: CPU (not reported), RAM (not reported), temperature (no readable sensor)'
  )
  // Only the CPU is missing: the rest is shown, and only the CPU is spoken of.
  const noCpu = statsLineToSnapshot(reading('{"v":1,"seq":2,"cores":8,"mem":[16000000,8000000]}'), null)
  assert.equal(formatStatusText(noCpu), 'RAM 7.6/15.3G')
  assert.deepEqual(noCpu.problems, ['CPU (not reported)', 'temperature (no readable sensor)'])
})

test('memory past its total is the whole of it, and no total is none', () => {
  assert.deepEqual(statsLineToSnapshot(reading('{"v":1,"seq":1,"mem":[100,150]}'), null).memory, {
    usedBytes: 100 * KIB,
    totalBytes: 100 * KIB,
    percent: 100
  })
  assert.equal(statsLineToSnapshot(reading('{"v":1,"seq":1,"mem":[0,0]}'), null).memory, null)
})
