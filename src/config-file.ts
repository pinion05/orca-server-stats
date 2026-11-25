// The config file: the settings in a JSON file, for an agent or a script to set where the Settings
// screen cannot be reached. It is read again before every reading, and a value it gives comes
// before the Settings screen's. What it gets wrong is left to the Settings screen and said once:
// nothing here throws, and no file is not an error.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expandHome } from './orca-cli'

/** The environment variable that names the file: for a script or a test, or a file kept somewhere else. */
export const CONFIG_FILE_ENV = 'ORCA_SERVER_STATS_CONFIG'

/**
 * Where the config file is: the path the environment names when `ORCA_SERVER_STATS_CONFIG` is set
 * and not empty, else `~/.config/orca-server-stats/config.json`. `~` at the start names the home
 * folder in both.
 */
export function configFilePath(env: Record<string, string | undefined>, home: string): string {
  const named = env[CONFIG_FILE_ENV]?.trim() ?? ''
  return named === '' ? join(home, '.config', 'orca-server-stats', 'config.json') : expandHome(named, home)
}

/** What one setting takes in the file, which is what the Settings screen takes for it too. */
type Format = {
  takes(value: unknown): boolean
  /** Why a value is not taken, as said after its key: `refreshSeconds is not a whole number from 1 to 60`. */
  fault: string
}

const text = (maxLength: number): Format => ({
  takes: (value): boolean => typeof value === 'string' && value.length <= maxLength,
  fault: `is not text of at most ${maxLength} characters`
})

/**
 * The settings the file may set, in the order of `contributes.settings`, which is the order they
 * are named in when wrong. Each takes what its setting declares there; a test holds the two together.
 */
const FORMATS: readonly (readonly [key: string, format: Format])[] = [
  [
    'source',
    {
      takes: (value): boolean => value === 'local' || value === 'remote',
      fault: 'is not "local" or "remote"'
    }
  ],
  ['environment', text(128)],
  ['targetWorkspace', text(1024)],
  ['orcaCli', text(512)],
  [
    'refreshSeconds',
    {
      takes: (value): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 60,
      fault: 'is not a whole number from 1 to 60'
    }
  ]
]

/** The settings the file gives, by key. */
export type ConfigValues = Record<string, string | number>

export type ConfigFile = {
  /** What the file sets, by key: only what the Settings screen would also take. Nothing, when there is no file. */
  values: ConfigValues
  /** Why some of it was left to the Settings screen, in a few words for the tooltip; null when all of it was used. */
  problem: string | null
  /** The same as the log has it: the file, what was wrong with it, and what is used instead. Null with `problem`. */
  reason: string | null
}

/** No file, which is no error: nothing set, and nothing wrong. */
export function noConfigFile(): ConfigFile {
  return { values: {}, problem: null, reason: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A file that was not used as written: `values` is what of it was, `problem` says in a few words
 * what was not, and `reason` says it for the log.
 */
function refused(path: string, values: ConfigValues, problem: string, what: string, instead: string): ConfigFile {
  return {
    values,
    problem: `config file: ${problem}`,
    reason: `config file ${path}: ${what}; ${instead}`
  }
}

/**
 * The file's text as settings. A known key gives its value when the Settings screen would take it
 * too; when it would not, that key is left to the Settings screen and named, with how many more
 * are. A key that is no setting is passed over. Text that is not JSON leaves the whole of it to
 * the Settings screen.
 */
export function parseConfigFile(path: string, contents: string): ConfigFile {
  let parsed: unknown
  try {
    // A byte order mark, as Windows editors write one, is not part of the JSON.
    parsed = JSON.parse(contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents)
  } catch {
    return refused(path, {}, 'invalid JSON', 'invalid JSON', 'the Settings values are used instead')
  }
  if (!isRecord(parsed)) {
    return refused(path, {}, 'not a JSON object', 'it is not a JSON object', 'the Settings values are used instead')
  }
  const values: ConfigValues = {}
  const wrong: string[] = []
  const faults: string[] = []
  for (const [key, format] of FORMATS) {
    if (!Object.hasOwn(parsed, key)) {
      continue
    }
    const value = parsed[key]
    if (format.takes(value)) {
      values[key] = value as string | number
    } else {
      wrong.push(key)
      faults.push(`${key} ${format.fault}`)
    }
  }
  if (wrong.length === 0) {
    return { values, problem: null, reason: null }
  }
  // The tooltip has room for one key and a count; the log names them all.
  const more = wrong.length > 1 ? ` +${wrong.length - 1} more` : ''
  return refused(
    path,
    values,
    `invalid ${wrong[0]}${more}`,
    faults.join(', '),
    'the Settings value is used for each'
  )
}

/**
 * The file as it is now. Never rejects: a file that is not there is no file, and one that is there
 * and cannot be read says so.
 */
export async function readConfigFile(path: string): Promise<ConfigFile> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    // Not there, or where a folder on the way is not one: no file, which is no error.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return noConfigFile()
    }
    const why = typeof code === 'string' && code !== '' ? `could not be read (${code})` : 'could not be read'
    return refused(path, {}, why, why, 'the Settings values are used instead')
  }
  return parseConfigFile(path, contents)
}
