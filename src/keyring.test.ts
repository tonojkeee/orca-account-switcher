import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, test } from 'orca/testing'
import {
  decodeGoKeyringPayload,
  decodeJwtPayload,
  encodeGoKeyringPayload,
  readCurrentAgyLogin,
  writeAgyCliCredentials
} from './keyring'
import { resolvePlatformPaths } from './platform'

function fakeJwt(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${head}.${body}.sig`
}

test('go-keyring-base64 encode/decode and JWT payload decode roundtrip cleanly', () => {
  const encoded = encodeGoKeyringPayload({ token: { refresh_token: 'rt-1' }, id_token_email: 'u@gmail.com' })
  assert.ok(encoded.startsWith('go-keyring-base64:'))
  const decoded = decodeGoKeyringPayload(encoded)
  assert.equal(decoded?.id_token_email, 'u@gmail.com')

  const claims = decodeJwtPayload(fakeJwt({ email: 'u@gmail.com', name: 'Alex' }))
  assert.equal(claims?.email, 'u@gmail.com')
  assert.equal(claims?.name, 'Alex')
})

test('readCurrentAgyLogin and writeAgyCliCredentials update all ~/.gemini and Orca ACP files', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orca-keyring-test-'))
  try {
    const paths = resolvePlatformPaths('linux', { XDG_CONFIG_HOME: path.join(home, '.config') }, home)
    mkdirSync(paths.geminiDir, { recursive: true })
    mkdirSync(paths.orcaAcpDir, { recursive: true })
    writeFileSync(path.join(paths.geminiDir, 'google_accounts.json'), JSON.stringify({ active: 'old@gmail.com', old: [] }))

    const res = await writeAgyCliCredentials(
      {
        email: 'new@gmail.com',
        accessToken: 'at-new',
        refreshToken: 'rt-new',
        expiresIn: 3600,
        expiryIso: '2026-11-22T12:00:00.000Z',
        expiryMs: 1795348800000,
        idToken: fakeJwt({ email: 'new@gmail.com' }),
        scope: 'openid email',
        oauthTemplate: { client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-old' }
      },
      paths,
      'other' as NodeJS.Platform
    )
    assert.equal(res.keyringWritten, false)

    const ga = JSON.parse(readFileSync(path.join(paths.geminiDir, 'google_accounts.json'), 'utf8')) as { active: string; old: string[] }
    assert.equal(ga.active, 'new@gmail.com')
    assert.deepEqual(ga.old, ['old@gmail.com'])

    const jetski = JSON.parse(readFileSync(path.join(paths.geminiDir, 'jetski-standalone-oauth-token'), 'utf8')) as {
      id_token_email: string
      token: { refresh_token: string; access_token: string }
    }
    assert.equal(jetski.id_token_email, 'new@gmail.com')
    assert.equal(jetski.token.refresh_token, 'rt-new')
    assert.equal(jetski.token.access_token, 'at-new')

    const agyCliTok = JSON.parse(
      readFileSync(path.join(paths.geminiDir, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')
    ) as {
      id_token_email: string
      token: { refresh_token: string; access_token: string }
    }
    assert.equal(agyCliTok.id_token_email, 'new@gmail.com')
    assert.equal(agyCliTok.token.refresh_token, 'rt-new')

    const acp = JSON.parse(readFileSync(paths.orcaAcpTokenPath, 'utf8')) as { refresh_token: string }
    assert.equal(acp.refresh_token, 'rt-new')
    assert.equal(existsSync(path.join(paths.orcaChatDir, 'jetski-standalone-oauth-token')), true)
    assert.equal(existsSync(path.join(paths.orcaAcpDir, '.token_timestamp')), true)
    assert.equal(existsSync(path.join(paths.geminiDir, '.token_timestamp')), true)

    const readBack = await readCurrentAgyLogin(paths, 'other' as NodeJS.Platform)
    assert.equal(readBack?.email, 'new@gmail.com')
    assert.equal(readBack?.refreshToken, 'rt-new')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
