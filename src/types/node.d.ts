// The little of Node this plugin calls, declared by hand. Orca's plugin typings ship without
// @types/node and the plugin carries no npm dependency, so this is what makes `tsc -p .` a real
// check. Each signature is the one the code uses, as @types/node gives it: add to it, never loosen
// it. The same sources also type-check against a real @types/node with this file left out, which
// is how the two are known to agree.

declare const process: {
  readonly platform:
    | 'aix'
    | 'android'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'openbsd'
    | 'sunos'
    | 'win32'
    | 'cygwin'
    | 'netbsd'
  readonly env: Record<string, string | undefined>
  /** Whether a process is still there: throws when it is not. */
  kill(pid: number, signal?: string | number): true
}

declare module 'node:os' {
  export interface CpuInfo {
    model: string
    speed: number
    times: { user: number; nice: number; sys: number; idle: number; irq: number }
  }
  export function cpus(): CpuInfo[]
  export function totalmem(): number
  export function freemem(): number
  export function loadavg(): number[]
  export function uptime(): number
  export function tmpdir(): string
  export function homedir(): string
}

declare module 'node:path' {
  export const delimiter: string
  export function join(...parts: string[]): string
  export function dirname(path: string): string
  export function isAbsolute(path: string): boolean
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string
}

declare module 'node:fs' {
  export interface Dirent {
    readonly name: string
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink(): boolean
  }
  /** Throws when the file is not there. */
  export function accessSync(path: string): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function statSync(path: string): { isFile(): boolean }
  export function openSync(path: string, flags?: string): number
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number
  export function closeSync(fd: number): void
}

declare module 'node:fs/promises' {
  export function readFile(file: string, encoding: 'utf8'): Promise<string>
  export function readdir(file: string): Promise<string[]>
  export function readdir(file: string, options: { withFileTypes: true }): Promise<import('node:fs').Dirent[]>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  export function mkdtemp(prefix: string): Promise<string>
  export function writeFile(file: string, data: string): Promise<void>
  export function symlink(target: string, path: string): Promise<void>
  export function chmod(path: string, mode: number): Promise<void>
  export function unlink(path: string): Promise<void>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
}

declare module 'node:child_process' {
  export interface ExecFileOptions {
    timeout?: number
    maxBuffer?: number
    windowsHide?: boolean
    env?: Record<string, string | undefined>
    killSignal?: string
  }
  export interface ExecFileException extends Error {
    code?: number | string
    killed?: boolean
    signal?: string
  }
  export interface ChildProcess {
    kill(signal?: string): boolean
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
  ): ChildProcess
  /** Sync form of execFile; returns stdout as a string. */
  export function execFileSync(
    file: string,
    args: readonly string[],
    options?: { encoding?: string; env?: Record<string, string | undefined> }
  ): string
}
