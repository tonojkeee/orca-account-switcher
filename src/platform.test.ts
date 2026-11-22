import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, test } from 'orca/testing'
import {
  buildCommandInvocation,
  findAgyCli,
  findAgyToolsCli,
  findOrcaCli,
  linkOrCopyFile,
  resolvePlatformPaths,
  sanitizeChildEnv,
  writeFileAtomic
} from './platform'

test('resolvePlatformPaths returns OS-native Orca userData paths', () => {
  const mac = resolvePlatformPaths('darwin', {}, '/Users/alex')
  assert.equal(mac.orcaUserDataDir, path.join('/Users/alex', 'Library', 'Application Support', 'orca'))
  assert.equal(mac.agyAccountsDir, path.join('/Users/alex', '.antigravity_tools', 'accounts'))

  const win = resolvePlatformPaths('win32', { APPDATA: 'C:\\Users\\Alex\\AppData\\Roaming' }, 'C:\\Users\\Alex')
  assert.equal(win.orcaUserDataDir, path.win32.join('C:\\Users\\Alex\\AppData\\Roaming', 'orca'))
  assert.equal(win.orcaAcpTokenPath, path.win32.join('C:\\Users\\Alex\\AppData\\Roaming', 'orca', 'antigravity-chat', 'antigravity-acp', 'acp_token.json'))

  const lin = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: '/home/alex/.cfg' }, '/home/alex')
  assert.equal(lin.orcaUserDataDir, path.join('/home/alex/.cfg', 'orca'))

  const custom = resolvePlatformPaths('linux', { ORCA_USER_DATA_PATH: '/custom/orca' }, '/home/alex')
  assert.equal(custom.orcaUserDataDir, '/custom/orca')
})

test('findOrcaCli discovers PATH and platform fallback binaries', () => {
  const winCmd = 'C:\\Users\\Alex\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.cmd'
  assert.equal(
    findOrcaCli('win32', { LOCALAPPDATA: 'C:\\Users\\Alex\\AppData\\Local', PATH: '' }, 'C:\\Users\\Alex', (p) => p === winCmd),
    winCmd
  )

  const macBin = '/Applications/Orca.app/Contents/Resources/bin/orca'
  assert.equal(
    findOrcaCli('darwin', { PATH: '/usr/bin' }, '/Users/alex', (p) => p === macBin),
    macBin
  )

  const linPathBin = '/usr/local/bin/orca'
  assert.equal(
    findOrcaCli('linux', { PATH: '/bin:/usr/local/bin' }, '/home/alex', (p) => p === linPathBin),
    linPathBin
  )

  assert.equal(
    findAgyToolsCli('win32', { PATH: 'C:\\Tools' }, 'C:\\Users\\Alex', (p) => p === path.win32.join('C:\\Tools', 'antigravity-tools.exe')),
    path.win32.join('C:\\Tools', 'antigravity-tools.exe')
  )

  // Prefer native agy.exe fallback over npm agy.cmd wrapper on Windows
  const winAgyCmd = path.win32.join('C:\\Npm', 'agy.cmd')
  const winAgyExe = path.win32.join('C:\\Users\\Alex', '.local', 'bin', 'agy.exe')
  assert.equal(
    findAgyCli('win32', { PATH: 'C:\\Npm' }, 'C:\\Users\\Alex', (p) => p === winAgyCmd || p === winAgyExe),
    winAgyExe
  )
})

test('sanitizeChildEnv strips ELECTRON_RUN_AS_NODE, sets Windows APPDATA/ORCA_USER_DATA_PATH, and wraps Windows .cmd verbatim', () => {
  const clean = sanitizeChildEnv(
    {
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect',
      ORCA_CLI_COMMAND: 'C:\\orca.cmd',
      ORCA_CLI_HANDOFF: 'C:\\orca.cmd'
    },
    'linux',
    '/home/alex'
  )
  assert.equal(clean.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(clean.NODE_OPTIONS, undefined)
  assert.equal(clean.ORCA_CLI_COMMAND, undefined)
  assert.equal(clean.ORCA_CLI_HANDOFF, undefined)
  assert.equal(clean.PATH, '/usr/bin')
  assert.equal(clean.HOME, '/home/alex')

  // Windows worker env often lacks APPDATA or has mixed-case Path; ensure canonical APPDATA & ORCA_USER_DATA_PATH are synthesized
  const winClean = sanitizeChildEnv(
    { Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\quiet' },
    'win32',
    'C:\\Users\\quiet'
  )
  assert.equal(winClean.APPDATA, 'C:\\Users\\quiet\\AppData\\Roaming')
  assert.equal(winClean.LOCALAPPDATA, 'C:\\Users\\quiet\\AppData\\Local')
  assert.equal(winClean.ORCA_USER_DATA_PATH, 'C:\\Users\\quiet\\AppData\\Roaming\\orca')
  assert.equal(winClean.PATH, 'C:\\Windows\\System32')
  assert.equal(winClean.Path, undefined)

  const winCmd = buildCommandInvocation('C:\\Program Files\\Orca\\orca.cmd', ['account', 'list', '--json'], 'win32', {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe'
  })
  assert.equal(winCmd.program, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(winCmd.windowsVerbatimArguments, true)
  assert.deepEqual(winCmd.args, [
    '/d /v:off /s /c ""C:\\Program Files\\Orca\\orca.cmd" "account" "list" "--json""'
  ])

  const winExe = buildCommandInvocation('C:\\Orca\\orca.exe', ['account', 'list'], 'win32', {})
  assert.equal(winExe.program, 'C:\\Orca\\orca.exe')
  assert.equal(winExe.windowsVerbatimArguments, undefined)
  assert.deepEqual(winExe.args, ['account', 'list'])
})

test('writeFileAtomic and linkOrCopyFile persist target contents cleanly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-plat-test-'))
  try {
    const src = path.join(dir, 'src.txt')
    const dst = path.join(dir, 'nested', 'dst.txt')
    writeFileAtomic(src, 'hello-token')
    assert.equal(readFileSync(src, 'utf8'), 'hello-token')

    linkOrCopyFile(src, dst)
    assert.equal(readFileSync(dst, 'utf8'), 'hello-token')

    // Overwrite existing file cleanly
    writeFileSync(src, 'updated-token', 'utf8')
    linkOrCopyFile(src, dst)
    assert.equal(readFileSync(dst, 'utf8'), 'updated-token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
