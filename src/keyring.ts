// Cross-platform OS keyring and ~/.gemini credential reader/writer for `agy` CLI and Orca ACP.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { asString } from './parse'
import {
  linkOrCopyFile,
  readJsonObject,
  sanitizeChildEnv,
  writeFileAtomic,
  type PlatformKind,
  type PlatformPaths
} from './platform'

const KEYRING_PREFIX = 'go-keyring-base64:'
const KEYRING_SERVICE = 'gemini'
const KEYRING_ACCOUNT = 'antigravity'
const WINDOWS_TARGET = `${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`

export type AgyStoredToken = {
  email: string | null
  refreshToken: string
  accessToken: string | null
  idToken: string | null
  source: string
}

export type AgyCredentialBundle = {
  email: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  expiryIso: string
  expiryMs: number
  idToken: string | null
  scope: string
  oauthTemplate: Record<string, unknown> | null
}

export function encodeGoKeyringPayload(jsonObj: Record<string, unknown>): string {
  return KEYRING_PREFIX + Buffer.from(JSON.stringify(jsonObj), 'utf8').toString('base64')
}

export function decodeGoKeyringPayload(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const jsonStr = trimmed.startsWith(KEYRING_PREFIX)
      ? Buffer.from(trimmed.slice(KEYRING_PREFIX.length), 'base64').toString('utf8')
      : trimmed
    const parsed: unknown = JSON.parse(jsonStr)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function decodeJwtPayload(jwt: string | null): Record<string, unknown> | null {
  if (!jwt) return null
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const parsed: unknown = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function execText(program: string, args: readonly string[], stdinData?: string, extraEnv?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], {
      env: { ...sanitizeChildEnv(process.env), ...extraEnv },
      stdio: [stdinData !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Ignore
      }
      resolve({ code: 1, stdout })
    }, 8000)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: 1, stdout: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout })
    })
    if (stdinData !== undefined && child.stdin) {
      child.stdin.end(stdinData, 'utf8')
    }
  })
}

const WIN_CRED_READ_PS = `
$t = $env:ORCA_CRED_TARGET
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CredManRead {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public uint LastWrittenLow; public uint LastWrittenHigh; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return "";
    try {
      var c = Marshal.PtrToStructure<CREDENTIAL>(ptr);
      if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return "";
      byte[] bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, (int)c.CredentialBlobSize);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(ptr); }
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[CredManRead]::Read($t)
`

const WIN_CRED_WRITE_PS = `
$t = $env:ORCA_CRED_TARGET
$u = $env:ORCA_CRED_USER
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$s = [Console]::In.ReadToEnd().Trim()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CredManWrite {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public uint LastWrittenLow; public uint LastWrittenHigh; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);
  public static bool Write(string target, string user, string secret) {
    byte[] bytes = Encoding.UTF8.GetBytes(secret);
    IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, ptr, bytes.Length);
      var c = new CREDENTIAL {
        Type = 1, TargetName = target, UserName = user,
        CredentialBlobSize = (uint)bytes.Length, CredentialBlob = ptr, Persist = 2
      };
      return CredWrite(ref c, 0);
    } finally { Marshal.FreeHGlobal(ptr); }
  }
}
"@
if (-not [CredManWrite]::Write($t, $u, $s)) { exit 1 }
`

function resolveWindowsPowerShell(): string {
  const sysRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || 'C:\\Windows'
  const candidate = path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export async function readAgyKeyringEntry(platform: PlatformKind = process.platform): Promise<Record<string, unknown> | null> {
  if (platform === 'darwin') {
    const res = await execText('security', ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w'])
    return res.code === 0 ? decodeGoKeyringPayload(res.stdout) : null
  }
  if (platform === 'linux') {
    const res = await execText('secret-tool', ['lookup', 'service', KEYRING_SERVICE, 'account', KEYRING_ACCOUNT])
    return res.code === 0 ? decodeGoKeyringPayload(res.stdout) : null
  }
  if (platform === 'win32') {
    const res = await execText(
      resolveWindowsPowerShell(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(WIN_CRED_READ_PS)],
      undefined,
      { ORCA_CRED_TARGET: WINDOWS_TARGET }
    )
    return res.code === 0 ? decodeGoKeyringPayload(res.stdout) : null
  }
  return null
}

export async function writeAgyKeyringEntry(
  payload: Record<string, unknown>,
  platform: PlatformKind = process.platform
): Promise<boolean> {
  const encoded = encodeGoKeyringPayload(payload)
  if (platform === 'darwin') {
    // Use stdin `-i` mode? `security` doesn't support `-w` via stdin cleanly, so update via add-generic-password.
    return new Promise((resolve) => {
      execFile(
        'security',
        ['add-generic-password', '-U', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w', encoded],
        { env: sanitizeChildEnv(process.env), timeout: 8000 },
        (err) => resolve(!err)
      )
    })
  }
  if (platform === 'linux') {
    const res = await execText(
      'secret-tool',
      ['store', '--label=antigravity', 'service', KEYRING_SERVICE, 'account', KEYRING_ACCOUNT],
      encoded
    )
    return res.code === 0
  }
  if (platform === 'win32') {
    const res = await execText(
      resolveWindowsPowerShell(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(WIN_CRED_WRITE_PS)],
      encoded,
      { ORCA_CRED_TARGET: WINDOWS_TARGET, ORCA_CRED_USER: KEYRING_ACCOUNT }
    )
    return res.code === 0
  }
  return false
}

function extractStoredToken(obj: Record<string, unknown> | null, activeEmail: string | null, source: string): AgyStoredToken | null {
  if (!obj) return null
  const tokObj = obj.token && typeof obj.token === 'object' ? (obj.token as Record<string, unknown>) : obj
  const refreshToken = asString(tokObj.refresh_token)
  if (!refreshToken) return null
  const idToken = asString(obj.id_token) ?? asString(tokObj.id_token)
  const claims = decodeJwtPayload(idToken)
  const email = asString(obj.id_token_email) ?? asString(claims?.email) ?? activeEmail
  return {
    email,
    refreshToken,
    accessToken: asString(tokObj.access_token),
    idToken,
    source
  }
}

/** Read whichever Antigravity/Gemini credential `agy` CLI or Orca ACP is currently signed into. */
export async function readCurrentAgyLogin(
  paths: PlatformPaths,
  platform: PlatformKind = process.platform
): Promise<AgyStoredToken | null> {
  const ga = readJsonObject(path.join(paths.geminiDir, 'google_accounts.json'))
  const activeEmail = asString(ga?.active)

  const fromKeyring = extractStoredToken(await readAgyKeyringEntry(platform), activeEmail, 'os-keyring')
  if (fromKeyring) return fromKeyring

  const fromAgyCliFile = extractStoredToken(
    readJsonObject(path.join(paths.geminiDir, 'antigravity-cli', 'antigravity-oauth-token')),
    activeEmail,
    'antigravity-cli-file'
  )
  if (fromAgyCliFile) return fromAgyCliFile

  const fromJetski = extractStoredToken(
    readJsonObject(path.join(paths.geminiDir, 'jetski-standalone-oauth-token')),
    activeEmail,
    'jetski-file'
  )
  if (fromJetski) return fromJetski

  const fromOauthCreds = extractStoredToken(
    readJsonObject(path.join(paths.geminiDir, 'oauth_creds.json')),
    activeEmail,
    'oauth-creds'
  )
  if (fromOauthCreds) return fromOauthCreds

  return extractStoredToken(readJsonObject(paths.orcaAcpTokenPath), activeEmail, 'orca-acp')
}

/** Write all `agy` CLI, Gemini CLI, and Orca ACP credentials atomically so switching takes effect on the fly. */
export async function writeAgyCliCredentials(
  bundle: AgyCredentialBundle,
  paths: PlatformPaths,
  platform: PlatformKind = process.platform
): Promise<{ keyringWritten: boolean; warnings: string[] }> {
  const warnings: string[] = []
  const agyTokenPayload: Record<string, unknown> = {
    token: {
      access_token: bundle.accessToken,
      token_type: 'Bearer',
      refresh_token: bundle.refreshToken,
      expiry: bundle.expiryIso,
      expires_in: bundle.expiresIn
    },
    auth_method: 'consumer',
    id_token_email: bundle.email,
    ...(bundle.idToken ? { id_token: bundle.idToken } : {})
  }

  const keyringPayload: Record<string, unknown> = {
    token: agyTokenPayload.token,
    auth_method: 'consumer',
    id_token_email: bundle.email
  }

  const keyringWritten = await writeAgyKeyringEntry(keyringPayload, platform)
  if (!keyringWritten) {
    warnings.push(
      platform === 'win32'
        ? 'Windows Credential Manager write failed; if agy stays on old account, run: cmdkey /delete:gemini:antigravity'
        : 'OS keyring write skipped or unavailable; using file storage'
    )
  }

  const agyCliTokenPath = path.join(paths.geminiDir, 'antigravity-cli', 'antigravity-oauth-token')
  writeFileAtomic(agyCliTokenPath, JSON.stringify(agyTokenPayload, null, 2))

  const jetskiPath = path.join(paths.geminiDir, 'jetski-standalone-oauth-token')
  writeFileAtomic(jetskiPath, JSON.stringify(agyTokenPayload, null, 2))

  const oauthCredsPath = path.join(paths.geminiDir, 'oauth_creds.json')
  writeFileAtomic(
    oauthCredsPath,
    JSON.stringify(
      {
        access_token: bundle.accessToken,
        refresh_token: bundle.refreshToken,
        token_type: 'Bearer',
        expiry_date: bundle.expiryMs,
        ...(bundle.idToken ? { id_token: bundle.idToken } : {}),
        scope: bundle.scope
      },
      null,
      2
    )
  )

  const gaPath = path.join(paths.geminiDir, 'google_accounts.json')
  const prevGa = readJsonObject(gaPath)
  const prevActive = asString(prevGa?.active)
  const prevOld = Array.isArray(prevGa?.old) ? prevGa.old.filter((x): x is string => typeof x === 'string') : []
  const nextOld = prevActive && prevActive.toLowerCase() !== bundle.email.toLowerCase()
    ? Array.from(new Set([prevActive, ...prevOld])).filter((e) => e.toLowerCase() !== bundle.email.toLowerCase())
    : prevOld.filter((e) => e.toLowerCase() !== bundle.email.toLowerCase())
  writeFileAtomic(gaPath, JSON.stringify({ active: bundle.email, old: nextOld }, null, 2))

  if (bundle.oauthTemplate) {
    writeFileAtomic(
      paths.orcaAcpTokenPath,
      JSON.stringify({ ...bundle.oauthTemplate, refresh_token: bundle.refreshToken }, null, 2)
    )
  }

  const dstJetski = path.join(paths.orcaChatDir, 'jetski-standalone-oauth-token')
  if (existsSync(jetskiPath)) {
    try {
      linkOrCopyFile(jetskiPath, dstJetski)
    } catch (error) {
      warnings.push(`Orca jetski link failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { keyringWritten, warnings }
}
