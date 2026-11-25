// The config file: where it is, what it may hold, and what is said of it when it cannot be used.
// The texts are the test's own; only the reads go to a real folder, which the test makes and removes.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from 'orca/testing'
import { CONFIG_FILE_ENV, configFilePath, noConfigFile, parseConfigFile, readConfigFile, type ConfigFile } from './config-file'
import { emptySnapshot, formatTooltip } from './metrics'
import * as main from './worker'

/** A made-up place for the file, as a log line would name it. */
const FILE = '/home/me/.config/orca-server-stats/config.json'
/** A made-up workspace selector, as `orca worktree ps --json` gives one. */
const WORKSPACE = 'id:11111111-1111-1111-1111-111111111111::/home/me/projects/site'

/** What the tooltip makes of a file's `problem`: whole, or cut with an ellipsis. */
const said = (file: ConfigFile): string => formatTooltip(emptySnapshot(file.problem === null ? [] : [file.problem]))

test('the file is where the environment names it, and else in the home folder', () => {
  assert.equal(configFilePath({}, '/home/me'), FILE)
  // Set to nothing is not set.
  assert.equal(configFilePath({ [CONFIG_FILE_ENV]: '' }, '/home/me'), FILE)
  assert.equal(configFilePath({ [CONFIG_FILE_ENV]: '  ' }, '/home/me'), FILE)
  assert.equal(configFilePath({ [CONFIG_FILE_ENV]: '/etc/server-stats.json' }, '/home/me'), '/etc/server-stats.json')
  // `~` names the home folder in both, and room around the path is not part of it.
  assert.equal(configFilePath({ [CONFIG_FILE_ENV]: ' ~/elsewhere/stats.json ' }, '/home/me'), join('/home/me', 'elsewhere/stats.json'))
  assert.equal(configFilePath({ [CONFIG_FILE_ENV]: '~' }, '/home/me'), '/home/me')
  // Another variable names nothing.
  assert.equal(configFilePath({ ORCA_SERVER_STATS_CONFIG_FILE: '/etc/other.json' }, '/home/me'), FILE)
  assert.equal(CONFIG_FILE_ENV, 'ORCA_SERVER_STATS_CONFIG')
})

test('the settings the file gives are the settings the manifest declares, and each takes what it allows there', async () => {
  const manifest = JSON.parse(
    await readFile(fileURLToPath(new URL('../orca-plugin.json', import.meta.url)), 'utf8')
  ) as {
    contributes: {
      settings: { key: string; type: string; maxLength?: number; minimum?: number; maximum?: number; enum?: string[] }[]
    }
  }
  const settings = manifest.contributes.settings
  /** A value the setting declares that it takes. */
  const allowed = (setting: (typeof settings)[number]): string | number =>
    setting.enum ? setting.enum[0] : setting.type === 'integer' ? (setting.minimum ?? 0) : ''
  /** Whether the file takes `value` for the setting, on its own. */
  const takes = (setting: (typeof settings)[number], value: unknown): boolean =>
    parseConfigFile(FILE, JSON.stringify({ [setting.key]: value })).problem === null

  // Every setting is known to the file, in the manifest's order, and to the worker by the same name.
  const all = parseConfigFile(
    FILE,
    JSON.stringify(Object.fromEntries(settings.map((setting) => [setting.key, allowed(setting)])))
  )
  assert.equal(all.problem, null)
  assert.deepEqual(Object.keys(all.values), settings.map((setting) => setting.key))
  assert.deepEqual(
    [main.SOURCE_SETTING, main.ENVIRONMENT_SETTING, main.WORKSPACE_SETTING, main.CLI_SETTING, main.REFRESH_SETTING],
    settings.map((setting) => setting.key)
  )
  for (const setting of settings) {
    const { key, minimum, maximum } = setting
    if (setting.enum) {
      for (const value of setting.enum) {
        assert.ok(takes(setting, value), `${key}: ${value}`)
      }
      assert.ok(!takes(setting, `not-${setting.enum[0]}`), key)
    }
    if (setting.type === 'integer') {
      assert.ok(minimum !== undefined && maximum !== undefined, key)
      assert.ok(takes(setting, minimum) && takes(setting, maximum), key)
      assert.ok(!takes(setting, minimum - 1) && !takes(setting, maximum + 1), key)
      // Text that says a number is not one, and neither is a fraction.
      assert.ok(!takes(setting, String(minimum)) && !takes(setting, minimum + 0.5), key)
    }
    if (setting.maxLength !== undefined) {
      assert.ok(takes(setting, 'x'.repeat(setting.maxLength)), key)
      assert.ok(!takes(setting, 'x'.repeat(setting.maxLength + 1)), key)
    }
  }
})

test('a file gives its settings as the Settings screen would take them, and passes over keys that are no setting', () => {
  const values = {
    source: 'remote',
    environment: 'my-server',
    targetWorkspace: WORKSPACE,
    orcaCli: '~/.config/orca/cli/bin/orca',
    refreshSeconds: 5
  }
  assert.deepEqual(parseConfigFile(FILE, JSON.stringify(values)), { values, problem: null, reason: null })
  // Part of them, beside keys that are no setting and a byte order mark before them.
  assert.deepEqual(parseConfigFile(FILE, '\ufeff{"refreshSeconds": 3, "colour": "red", "source": "local"}'), {
    values: { source: 'local', refreshSeconds: 3 },
    problem: null,
    reason: null
  })
  // Empty text is a setting too: this computer's own Orca, and the default CLI.
  assert.deepEqual(parseConfigFile(FILE, '{"environment": "", "orcaCli": ""}').values, { environment: '', orcaCli: '' })
  assert.deepEqual(parseConfigFile(FILE, '{}').values, {})
})

/** What the log says of each setting whose value was not taken. */
const FAULTS: Record<string, string> = {
  source: 'source is not "local" or "remote"',
  environment: 'environment is not text of at most 128 characters',
  targetWorkspace: 'targetWorkspace is not text of at most 1024 characters',
  orcaCli: 'orcaCli is not text of at most 512 characters',
  refreshSeconds: 'refreshSeconds is not a whole number from 1 to 60'
}

test('a value the Settings screen would not take is left to it, and the key is named', () => {
  const wrong: Array<[key: string, value: unknown]> = [
    ['source', 'Remote'],
    ['source', ' remote '],
    ['source', ''],
    ['source', null],
    ['source', 1],
    ['environment', 5],
    ['environment', null],
    ['environment', ['my-server']],
    ['environment', 'x'.repeat(129)],
    ['targetWorkspace', false],
    ['targetWorkspace', 'x'.repeat(1025)],
    ['orcaCli', 3],
    ['orcaCli', 'x'.repeat(513)],
    ['refreshSeconds', '5'],
    ['refreshSeconds', 2.5],
    ['refreshSeconds', 0],
    ['refreshSeconds', 61],
    ['refreshSeconds', true]
  ]
  for (const [key, value] of wrong) {
    const which = `${key}: ${JSON.stringify(value)}`
    const file = parseConfigFile(FILE, JSON.stringify({ [key]: value }))
    assert.deepEqual(file.values, {}, which)
    assert.equal(file.problem, `config file: invalid ${key}`, which)
    assert.equal(file.reason, `config file ${FILE}: ${FAULTS[key]}; the Settings value is used for each`, which)
  }
  // The ends of what is allowed are allowed, and a number written with a decimal point is still whole.
  for (const text of ['{"refreshSeconds": 1}', '{"refreshSeconds": 60}', '{"refreshSeconds": 2.0}']) {
    assert.equal(parseConfigFile(FILE, text).problem, null, text)
  }
  assert.equal(parseConfigFile(FILE, JSON.stringify({ environment: 'x'.repeat(128) })).problem, null)
})

test('the settings that are wrong are named in the order of the manifest, with how many more there are, and the rest are used', () => {
  const some = parseConfigFile(
    FILE,
    '{"refreshSeconds": "5", "source": "remote", "orcaCli": 3, "environment": "my-server"}'
  )
  assert.deepEqual(some.values, { source: 'remote', environment: 'my-server' })
  assert.equal(some.problem, 'config file: invalid orcaCli +1 more')
  assert.equal(
    some.reason,
    `config file ${FILE}: ${FAULTS.orcaCli}, ${FAULTS.refreshSeconds}; the Settings value is used for each`
  )
  // All five, in another order than the manifest's.
  const all = parseConfigFile(
    FILE,
    '{"refreshSeconds": "4", "orcaCli": 3, "targetWorkspace": 2, "environment": 1, "source": "x"}'
  )
  assert.deepEqual(all.values, {})
  assert.equal(all.problem, 'config file: invalid source +4 more')
  assert.equal(
    all.reason,
    `config file ${FILE}: ${Object.values(FAULTS).join(', ')}; the Settings value is used for each`
  )
})

test('text that is not JSON, or not an object, leaves the whole of it to the Settings', () => {
  const invalid: ConfigFile = {
    values: {},
    problem: 'config file: invalid JSON',
    reason: `config file ${FILE}: invalid JSON; the Settings values are used instead`
  }
  for (const text of ['', '   ', '{', '{"source": "remote",}', '{"source": "remote"} trailing', '\ufeff']) {
    assert.deepEqual(parseConfigFile(FILE, text), invalid, JSON.stringify(text))
  }
  const notObject: ConfigFile = {
    values: {},
    problem: 'config file: not a JSON object',
    reason: `config file ${FILE}: it is not a JSON object; the Settings values are used instead`
  }
  for (const text of ['[]', '"remote"', '42', 'null', 'true']) {
    assert.deepEqual(parseConfigFile(FILE, text), notObject, text)
  }
})

test('what is said of a file that cannot be used is short enough for the tooltip, whole', () => {
  const problems = [
    'config file: invalid JSON',
    'config file: not a JSON object',
    'config file: could not be read (EACCES)',
    'config file: invalid source +4 more',
    'config file: invalid targetWorkspace +3 more'
  ]
  for (const problem of problems) {
    assert.equal(said({ values: {}, problem, reason: null }), `unavailable: ${problem}`)
  }
  // And of one that can be used, nothing.
  assert.equal(said(noConfigFile()), '')
})

test('the file as it is on disk: no file is no error, and one that cannot be read says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'server-stats-config-'))
  const none = noConfigFile()
  try {
    // Not there.
    assert.deepEqual(await readConfigFile(join(dir, 'config.json')), none)
    // Under what is a file, so in no folder.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a folder')
    assert.deepEqual(await readConfigFile(join(blocker, 'config.json')), none)
    assert.deepEqual(none, { values: {}, problem: null, reason: null })
    // A folder where the file should be.
    const folder = join(dir, 'folder')
    await mkdir(folder)
    const isFolder = await readConfigFile(folder)
    assert.deepEqual(isFolder.values, {})
    assert.match(isFolder.problem ?? '', /^config file: could not be read \([A-Z]+\)$/)
    assert.equal(
      isFolder.reason,
      `config file ${folder}: ${isFolder.problem?.slice('config file: '.length)}; the Settings values are used instead`
    )
    // There, and readable by root only: where this process can read it, that part is not tried.
    const locked = join(dir, 'locked.json')
    await writeFile(locked, '{"source": "remote"}')
    await chmod(locked, 0o000)
    const readable = await readFile(locked, 'utf8').then(
      () => true,
      () => false
    )
    if (!readable) {
      const forbidden = await readConfigFile(locked)
      assert.deepEqual(forbidden, {
        values: {},
        problem: 'config file: could not be read (EACCES)',
        reason: `config file ${locked}: could not be read (EACCES); the Settings values are used instead`
      })
    }
    await chmod(locked, 0o600)
    // There, as it should be.
    const good = join(dir, 'good.json')
    await writeFile(good, '{"source": "remote", "refreshSeconds": 4}\n')
    assert.deepEqual(await readConfigFile(good), { values: { source: 'remote', refreshSeconds: 4 }, problem: null, reason: null })
    // There, and not JSON: said with the file's own name.
    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{')
    const file = await readConfigFile(broken)
    assert.equal(file.problem, 'config file: invalid JSON')
    assert.equal(file.reason, `config file ${broken}: invalid JSON; the Settings values are used instead`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
