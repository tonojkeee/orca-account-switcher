// Cross-platform OS path discovery, sanitized command execution, and atomic file primitives.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type PlatformKind = NodeJS.Platform

export type PlatformPaths = {
  homeDir: string
  orcaUserDataDir: string
  orcaAcpDir: string
  orcaAcpTokenPath: string
  orcaChatDir: string
  geminiDir: string
  agyAccountsDir: string
}

const STRIPPED_WORKER_ENV_VARS = [
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'ORCA_CLI_COMMAND',
  'ORCA_CLI_HANDOFF'
] as const

function pathFor(platform: PlatformKind) {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Resolve standard Orca and Antigravity directories for macOS, Windows, and Linux. */
export function resolvePlatformPaths(
  platform: PlatformKind = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): PlatformPaths {
  const p = pathFor(platform)
  const orcaUserDataDir = resolveOrcaUserDataDir(platform, env, home)
  const orcaChatDir = p.join(orcaUserDataDir, 'antigravity-chat')
  const orcaAcpDir = p.join(orcaChatDir, 'antigravity-acp')
  return {
    homeDir: home,
    orcaUserDataDir,
    orcaChatDir,
    orcaAcpDir,
    orcaAcpTokenPath: p.join(orcaAcpDir, 'acp_token.json'),
    geminiDir: p.join(home, '.gemini'),
    agyAccountsDir: p.join(home, '.antigravity_tools', 'accounts')
  }
}

function resolveOrcaUserDataDir(platform: PlatformKind, env: NodeJS.ProcessEnv, home: string): string {
  const p = pathFor(platform)
  if (env.ORCA_USER_DATA_PATH?.trim()) return env.ORCA_USER_DATA_PATH.trim()
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'orca')
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || p.join(home, 'AppData', 'Roaming')
    return p.join(appData, 'orca')
  }
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || p.join(home, '.config')
  return p.join(xdgConfig, 'orca')
}

/** Return sanitized environment safe for spawning external CLIs from an Orca plugin worker. */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env }
  for (const key of STRIPPED_WORKER_ENV_VARS) {
    delete clean[key]
  }
  return clean
}

function splitPathEnv(env: NodeJS.ProcessEnv, platform: PlatformKind): string[] {
  const raw = platform === 'win32' ? (env.PATH ?? env.Path ?? '') : (env.PATH ?? '')
  const sep = platform === 'win32' ? ';' : ':'
  return raw.split(sep).map((s) => s.trim()).filter(Boolean)
}

function findOnPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: PlatformKind,
  fileExists: (p: string) => boolean
): string | null {
  const p = pathFor(platform)
  for (const dir of splitPathEnv(env, platform)) {
    for (const name of names) {
      const candidate = p.join(dir, name)
      if (fileExists(candidate)) return candidate
    }
  }
  return null
}

/** Locate the Orca CLI binary across macOS, Windows, and Linux. */
export function findOrcaCli(
  platform: PlatformKind = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fileExists: (p: string) => boolean = existsSync
): string | null {
  const override = env.ORCA_CLI_INSTALL_PATH?.trim()
  if (override && fileExists(override)) return override

  const pathNames = platform === 'win32' ? ['orca.cmd', 'orca.exe', 'orca'] : ['orca']
  const fromPath = findOnPath(pathNames, env, platform, fileExists)
  if (fromPath) return fromPath

  const fallbacks = orcaCliFallbackPaths(platform, env, home)
  return fallbacks.find((candidate) => fileExists(candidate)) ?? null
}

function orcaCliFallbackPaths(platform: PlatformKind, env: NodeJS.ProcessEnv, home: string): string[] {
  const p = pathFor(platform)
  if (platform === 'darwin') {
    return [
      '/Applications/Orca.app/Contents/Resources/bin/orca',
      p.join(home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'),
      '/usr/local/bin/orca',
      p.join(home, '.local', 'bin', 'orca')
    ]
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || p.join(home, 'AppData', 'Local')
    const programFiles = env.ProgramFiles?.trim() || 'C:\\Program Files'
    return [
      p.join(localAppData, 'Programs', 'Orca', 'resources', 'bin', 'orca.cmd'),
      p.join(localAppData, 'Programs', 'Orca', 'resources', 'bin', 'orca.exe'),
      p.join(programFiles, 'Orca', 'resources', 'bin', 'orca.cmd'),
      p.join(programFiles, 'Orca', 'resources', 'bin', 'orca.exe')
    ]
  }
  return [
    p.join(home, '.local', 'bin', 'orca'),
    '/usr/local/bin/orca',
    '/usr/bin/orca',
    '/opt/Orca/resources/bin/orca'
  ]
}

/** Locate the optional `antigravity-tools` CLI across macOS, Windows, and Linux. */
export function findAgyToolsCli(
  platform: PlatformKind = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fileExists: (p: string) => boolean = existsSync
): string | null {
  const p = pathFor(platform)
  const pathNames = platform === 'win32' ? ['antigravity-tools.exe', 'antigravity-tools.cmd', 'antigravity-tools'] : ['antigravity-tools']
  const fromPath = findOnPath(pathNames, env, platform, fileExists)
  if (fromPath) return fromPath

  const fallbacks =
    platform === 'darwin'
      ? ['/Applications/Antigravity Tools.app/Contents/MacOS/antigravity-tools', p.join(home, '.local', 'bin', 'antigravity-tools')]
      : platform === 'win32'
        ? [
            p.join(env.LOCALAPPDATA?.trim() || p.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity Tools', 'antigravity-tools.exe'),
            p.join(env.ProgramFiles?.trim() || 'C:\\Program Files', 'Antigravity Tools', 'antigravity-tools.exe')
          ]
        : [p.join(home, '.local', 'bin', 'antigravity-tools'), '/usr/local/bin/antigravity-tools', '/usr/bin/antigravity-tools']

  return fallbacks.find((candidate) => fileExists(candidate)) ?? null
}

/** Locate candidate `agy` CLI binaries across macOS, Windows, and Linux (preferring native .exe over .cmd on Windows). */
export function findAgyCliCandidates(
  platform: PlatformKind = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fileExists: (p: string) => boolean = existsSync
): string[] {
  const p = pathFor(platform)
  const found: string[] = []
  const seen = new Set<string>()
  const pushIfExists = (candidate: string | null) => {
    if (!candidate) return
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return
    if (fileExists(candidate)) {
      seen.add(key)
      found.push(candidate)
    }
  }

  const fallbacks =
    platform === 'darwin'
      ? [p.join(home, '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy']
      : platform === 'win32'
        ? [
            p.join(home, '.local', 'bin', 'agy.exe'),
            p.join(home, '.antigravity', 'bin', 'agy.exe'),
            p.join(env.LOCALAPPDATA?.trim() || p.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'agy.exe'),
            p.join(env.LOCALAPPDATA?.trim() || p.join(home, 'AppData', 'Local'), 'antigravity-cli', 'agy.exe')
          ]
        : [p.join(home, '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/usr/bin/agy']

  if (platform === 'win32') {
    for (const dir of splitPathEnv(env, platform)) {
      pushIfExists(p.join(dir, 'agy.exe'))
    }
    for (const fb of fallbacks) pushIfExists(fb)
    for (const dir of splitPathEnv(env, platform)) {
      pushIfExists(p.join(dir, 'agy.cmd'))
      pushIfExists(p.join(dir, 'agy'))
    }
  } else {
    pushIfExists(findOnPath(['agy'], env, platform, fileExists))
    for (const fb of fallbacks) pushIfExists(fb)
  }

  return found
}

/** Locate the `agy` CLI binary across macOS, Windows, and Linux. */
export function findAgyCli(
  platform: PlatformKind = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fileExists: (p: string) => boolean = existsSync
): string | null {
  return findAgyCliCandidates(platform, env, home, fileExists)[0] ?? null
}

export type ExecResult = {
  code: number
  stdout: string
  stderr: string
}

function quoteWindowsCmdArg(arg: string): string {
  if (arg.length > 0 && !/[\\"% \t]/.test(arg)) return `"${arg}"`
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1
      continue
    }
    if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2)}""`
      backslashes = 0
      continue
    }
    if (ch === '%') {
      out += `${'\\'.repeat(backslashes * 2)}"^%"`
      backslashes = 0
      continue
    }
    out += `${'\\'.repeat(backslashes)}${ch}`
    backslashes = 0
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

/** Build executable + arguments so Windows `.cmd`/`.bat` scripts run verbatim through cmd.exe even with spaces/quotes. */
export function buildCommandInvocation(
  executable: string,
  args: readonly string[],
  platform: PlatformKind = process.platform,
  env: NodeJS.ProcessEnv = process.env
): { program: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const comspec = env.ComSpec?.trim() || env.COMSPEC?.trim() || 'cmd.exe'
    const cmdLine = `/d /v:off /s /c "${[executable, ...args].map(quoteWindowsCmdArg).join(' ')}"`
    return { program: comspec, args: [cmdLine], windowsVerbatimArguments: true }
  }
  return { program: executable, args: [...args] }
}

/** Run a CLI command cross-platform with sanitized worker env and bounded timeout. */
export function runCommand(
  executable: string,
  args: readonly string[],
  timeoutMs = 15000
): Promise<ExecResult> {
  const inv = buildCommandInvocation(executable, args)
  return new Promise((resolve) => {
    const child = spawn(inv.program, inv.args, {
      env: sanitizeChildEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    })

    const maxBytes = 4 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (code: number, fallbackErr?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const cleanStderr = stderr.trim() || fallbackErr || ''
      resolve({ code, stdout, stderr: cleanStderr })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // Ignore kill error
      }
      finish(124, `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${executable}`)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      finish(1, err.message)
    })
    child.on('close', (code) => {
      if (timedOut) return
      finish(typeof code === 'number' ? code : 1)
    })
  })
}

/** Atomically write a UTF-8 file with restrictive permissions. */
export function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // Ignore cleanup failure
    }
    throw error
  }
}

/** Link `src` to `dst`, falling back to a file copy when symlinks are not permitted (e.g. Windows). */
export function linkOrCopyFile(src: string, dst: string): void {
  if (!existsSync(src)) return
  mkdirSync(path.dirname(dst), { recursive: true })
  try {
    rmSync(dst, { force: true })
  } catch {
    // Ignore if absent
  }
  try {
    symlinkSync(src, dst)
  } catch {
    copyFileSync(src, dst)
  }
}

/** Safely read and parse a JSON object file; returns null when absent or invalid. */
export function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
