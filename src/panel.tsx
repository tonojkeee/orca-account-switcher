// Declarative Orca sidebar panel: switches Orca managed agents, `agy` CLI, and built-in OAuth Vault on the fly.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  IconButton,
  Input,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  set,
  shell,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import type {
  AccountsSnapshot,
  AgyPoolAccount,
  OAuthStartResult,
  OrcaAgentKind,
  OrcaManagedAccount,
  OrcaProviderState,
  SwitchResult
} from './protocol'

const snapshotAtom = atom<AccountsSnapshot | null>(null)
const busyKeyAtom = atom<string | null>(null)
const feedbackAtom = atom<{ tone: Tone; text: string } | null>(null)
const activeTabAtom = atom('activeTab', 'orca', { persist: 'plugin' })
const oauthPendingAtom = atom<OAuthStartResult | null>(null)
const manualCallbackAtom = atom('')

function toneForQuota(pct: number | null): Tone {
  if (pct === null) return 'neutral'
  if (pct >= 50) return 'success'
  if (pct >= 15) return 'warning'
  return 'danger'
}

function sourceBadgeLabel(source: AgyPoolAccount['source']): string {
  if (source === 'both') return 'Vault + Tools'
  if (source === 'vault') return 'Vault'
  return 'AGY Tools'
}

async function refreshAccounts(): Promise<void> {
  if (read(busyKeyAtom) !== null) return
  set(busyKeyAtom, 'refresh')
  try {
    const snap = await plugin.request('accounts.snapshot', { refreshQuotas: true, force: true })
    set(snapshotAtom, snap)
  } catch (error) {
    set(feedbackAtom, {
      tone: 'danger',
      text: error instanceof Error ? error.message : 'Failed to refresh accounts'
    })
  } finally {
    set(busyKeyAtom, null)
  }
}

async function runAction(key: string, action: () => Promise<SwitchResult>): Promise<void> {
  if (read(busyKeyAtom) !== null) return
  set(busyKeyAtom, key)
  set(feedbackAtom, null)
  try {
    const res = await action()
    set(snapshotAtom, res.snapshot)
    set(feedbackAtom, { tone: res.ok ? 'success' : 'danger', text: res.message })
  } catch (error) {
    set(feedbackAtom, {
      tone: 'danger',
      text: error instanceof Error ? error.message : 'Action failed'
    })
  } finally {
    set(busyKeyAtom, null)
  }
}

async function startOAuthFlow(): Promise<void> {
  if (read(busyKeyAtom) !== null) return
  set(busyKeyAtom, 'oauth-start')
  set(feedbackAtom, null)
  try {
    const started = await plugin.request('accounts.beginGoogleOAuth')
    set(oauthPendingAtom, started)
    set(manualCallbackAtom, '')
  } catch (error) {
    set(feedbackAtom, {
      tone: 'danger',
      text: error instanceof Error ? error.message : 'Could not start Google OAuth'
    })
  } finally {
    set(busyKeyAtom, null)
  }
}

async function openOAuthInBrowser(): Promise<void> {
  const oauth = read(oauthPendingAtom)
  if (!oauth) return
  try {
    const opened = await shell.openExternal(oauth.authUrl)
    if (!opened.opened) {
      set(feedbackAtom, { tone: 'warning', text: 'Browser launch cancelled; copy the URL below (e.g. into Incognito).' })
    }
  } catch {
    set(feedbackAtom, { tone: 'warning', text: 'Copy the sign-in URL below into your browser.' })
  }
}

async function completeManualOAuth(): Promise<void> {
  const value = read(manualCallbackAtom).trim()
  if (!value) return
  await runAction('oauth-manual', async () => {
    const res = await plugin.request('accounts.completeGoogleOAuthManual', { callbackOrCode: value })
    if (res.ok) {
      set(oauthPendingAtom, null)
      set(manualCallbackAtom, '')
    }
    return res
  })
}

async function cancelOAuthFlow(): Promise<void> {
  set(oauthPendingAtom, null)
  set(manualCallbackAtom, '')
  await plugin.request('accounts.cancelGoogleOAuth').catch(() => undefined)
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('accounts.updated', (snap) => {
      set(snapshotAtom, snap)
    }),
    plugin.on('oauth.completed', (res) => {
      set(oauthPendingAtom, null)
      set(manualCallbackAtom, '')
      set(snapshotAtom, res.snapshot)
      set(feedbackAtom, { tone: res.ok ? 'success' : 'danger', text: res.message })
    })
  )
  void plugin
    .request('accounts.snapshot', { refreshQuotas: true })
    .then((snap) => set(snapshotAtom, snap))
    .catch((error) => {
      set(feedbackAtom, {
        tone: 'danger',
        text: error instanceof Error ? error.message : 'Could not load accounts'
      })
    })
}

function QuotaBar({ label, value }: { label: string; value: number }) {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text size="xs" muted>
          {label}
        </Text>
        <Badge tone={toneForQuota(value)}>{value}%</Badge>
      </Row>
      <Progress label={label} labelHidden value={value} />
    </Stack>
  )
}

function OrcaAccountRow({
  agent,
  account,
  busyKey
}: {
  agent: OrcaAgentKind
  account: OrcaManagedAccount
  busyKey: string | null
}) {
  const key = `orca:${agent}:${account.id}`
  return (
    <Box padding="sm" border={account.active ? 'accent' : true} radius="md" background={account.active ? 'card' : 'none'}>
      <Stack gap="sm">
        <Row justify="between" align="center" gap="xs">
          <Stack gap="none">
            <Row gap="xs" align="center" wrap>
              <Text size="sm" weight="semibold" truncate>
                {account.label}
              </Text>
              {account.active ? <Badge tone="success">Active</Badge> : null}
              {account.needsSignIn ? <Badge tone="warning">Re-auth</Badge> : null}
            </Row>
            {account.email && account.email !== account.label ? (
              <Text size="xs" muted truncate>
                {account.email}
              </Text>
            ) : null}
          </Stack>
          <Button
            size="xs"
            variant={account.active ? 'ghost' : 'solid'}
            tone={account.active ? 'neutral' : 'accent'}
            disabled={account.active || busyKey !== null}
            onPress={() => runAction(key, () => plugin.request('accounts.selectOrca', { agent, account: account.id }))}
          >
            {busyKey === key ? 'Switching…' : account.active ? 'Current' : 'Use'}
          </Button>
        </Row>
        {account.buckets.length > 0 ? (
          <Stack gap="xs">
            {account.buckets.slice(0, 8).map((bucket) => (
              <QuotaBar key={bucket.label} label={bucket.label} value={bucket.remainingPercent} />
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Box>
  )
}

function ProviderSection({ provider, busyKey }: { provider: OrcaProviderState; busyKey: string | null }) {
  const activeCount = provider.accounts.length
  const usingSystem = provider.supportsSystemDefault && provider.activeAccountId === null
  const sysKey = `orca:${provider.agent}:system`

  return (
    <Card
      title={provider.title}
      description={
        activeCount === 0
          ? provider.supportsSystemDefault
            ? `No managed accounts (${provider.systemDefaultLabel ?? 'system default'})`
            : 'No managed accounts saved in Orca'
          : `${activeCount} saved account${activeCount === 1 ? '' : 's'}`
      }
    >
      <Stack gap="sm">
        {provider.supportsSystemDefault ? (
          <Row justify="between" align="center" gap="xs">
            <Row gap="xs" align="center">
              <Text size="xs" muted>
                System default{provider.systemDefaultLabel ? ` · ${provider.systemDefaultLabel}` : ''}
              </Text>
              {usingSystem ? <Badge tone="success">Active</Badge> : null}
            </Row>
            <Button
              size="xs"
              variant="outline"
              disabled={usingSystem || busyKey !== null}
              onPress={() =>
                runAction(sysKey, () => plugin.request('accounts.selectOrca', { agent: provider.agent, account: 'system' }))
              }
            >
              {busyKey === sysKey ? 'Switching…' : 'Use system'}
            </Button>
          </Row>
        ) : null}
        {provider.accounts.map((acc) => (
          <OrcaAccountRow key={acc.id} agent={provider.agent} account={acc} busyKey={busyKey} />
        ))}
      </Stack>
    </Card>
  )
}

function AgyPoolRow({
  account,
  isBest,
  busyKey
}: {
  account: AgyPoolAccount
  isBest: boolean
  busyKey: string | null
}) {
  const key = `agy:${account.email}`
  const delKey = `agy-rm:${account.email}`
  const removable = account.source === 'vault' || account.source === 'both'
  return (
    <Box padding="sm" border={account.active ? 'accent' : true} radius="md" background={account.active ? 'card' : 'none'}>
      <Stack gap="sm">
        <Row justify="between" align="center" gap="xs">
          <Stack gap="none">
            <Row gap="xs" align="center" wrap>
              <Text size="sm" weight="semibold" truncate>
                {account.email}
              </Text>
              {account.active ? <Badge tone="success">Active</Badge> : null}
              {isBest ? <Badge tone="accent">Best</Badge> : null}
              <Badge tone="neutral">{sourceBadgeLabel(account.source)}</Badge>
            </Row>
            {account.name ? (
              <Text size="xs" muted truncate>
                {account.name}
              </Text>
            ) : null}
          </Stack>
          <Row gap="xs" align="center">
            {removable ? (
              <IconButton
                icon="delete"
                label={`Remove ${account.email} from vault`}
                variant="ghost"
                tone="danger"
                size="xs"
                disabled={busyKey !== null}
                onPress={() => runAction(delKey, () => plugin.request('accounts.removeVaultAccount', { email: account.email }))}
              />
            ) : null}
            <Button
              size="xs"
              variant={account.active ? 'ghost' : 'solid'}
              tone={account.active ? 'neutral' : 'accent'}
              disabled={account.active || busyKey !== null}
              onPress={() => runAction(key, () => plugin.request('accounts.selectAgyPool', { email: account.email }))}
            >
              {busyKey === key ? 'Switching…' : account.active ? 'Current' : 'Switch'}
            </Button>
          </Row>
        </Row>
        {account.error ? (
          <Text size="xs" tone="danger">
            {account.error}
          </Text>
        ) : (
          <Stack gap="xs">
            {account.gemini5h !== null ? <QuotaBar label="Gemini 5h" value={Math.round(account.gemini5h)} /> : null}
            {account.geminiWeekly !== null ? (
              <QuotaBar label="Gemini Weekly" value={Math.round(account.geminiWeekly)} />
            ) : null}
            {account.claudeWeekly !== null ? (
              <QuotaBar label="Claude / GPT Weekly" value={Math.round(account.claudeWeekly)} />
            ) : null}
          </Stack>
        )}
      </Stack>
    </Box>
  )
}

export default function Panel() {
  const snap = read(snapshotAtom)
  const busyKey = read(busyKeyAtom)
  const feedback = read(feedbackAtom)
  const tab = read(activeTabAtom)
  const oauth = read(oauthPendingAtom)
  const manualCallback = read(manualCallbackAtom)

  if (!snap) {
    return (
      <Stack gap="md" align="center">
        <Spinner label="Loading accounts" />
        <Text size="sm" muted>
          Reading Orca accounts and quotas…
        </Text>
      </Stack>
    )
  }

  const configuredProviders = snap.providers.filter((p) => p.accounts.length > 0 || p.systemDefaultLabel !== null)
  const emptyProviders = snap.providers.filter((p) => p.accounts.length === 0 && p.systemDefaultLabel === null)

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="xs">
        <Stack gap="none">
          <Heading level={2}>Accounts</Heading>
          <Row gap="xs" align="center">
            <Text size="xs" muted>
              Updated
            </Text>
            <RelativeTime at={snap.fetchedAt} format="short" muted />
          </Row>
        </Stack>
        <Row gap="xs" align="center">
          {snap.agyPool.available || (snap.providers.find((p) => p.agent === 'antigravity')?.accounts.length ?? 0) > 1 ? (
            <Button
              size="xs"
              variant="outline"
              tone="accent"
              icon="zap"
              tooltip="Switch agy CLI + Orca to highest remaining Gemini quota"
              disabled={busyKey !== null}
              onPress={() => runAction('best', () => plugin.request('accounts.switchBestAgy'))}
            >
              {busyKey === 'best' ? 'Switching…' : 'Best'}
            </Button>
          ) : null}
          <IconButton
            icon="refresh"
            label="Refresh accounts and quotas"
            variant="ghost"
            size="xs"
            disabled={busyKey !== null}
            onPress={refreshAccounts}
          />
        </Row>
      </Row>

      {feedback ? (
        <Callout tone={feedback.tone} icon={feedback.tone === 'danger' ? 'warning' : 'check'}>
          {feedback.text}
        </Callout>
      ) : null}

      {snap.orcaError ? (
        <Callout tone="warning" title="Orca CLI" icon="warning">
          {snap.orcaError}
        </Callout>
      ) : null}

      <Tabs label="Account source" value={tab} onChange={(next) => set(activeTabAtom, next)}>
        <Tab value="orca" label="Orca Agents" icon="agent">
          <Stack gap="sm">
            {configuredProviders.length === 0 ? (
              <EmptyState
                icon="agent"
                title="No Orca agent accounts"
                description="Add accounts in Orca Settings > AI Provider Accounts or via `orca account add`."
              />
            ) : (
              configuredProviders.map((provider) => (
                <ProviderSection key={provider.agent} provider={provider} busyKey={busyKey} />
              ))
            )}
            {emptyProviders.length > 0 ? (
              <Text size="xs" muted>
                Not configured: {emptyProviders.map((p) => p.title).join(', ')}
              </Text>
            ) : null}
          </Stack>
        </Tab>

        <Tab value="agy" label={`AGY Vault (${snap.agyPool.accounts.length})`} icon="zap">
          <Stack gap="sm">
            <Row gap="xs" wrap>
              <Button
                size="xs"
                variant="solid"
                tone="accent"
                icon="add"
                disabled={busyKey !== null}
                onPress={startOAuthFlow}
              >
                {busyKey === 'oauth-start' ? 'Starting…' : 'Add Google Account'}
              </Button>
              <Button
                size="xs"
                variant="outline"
                icon="download"
                tooltip="Save currently signed-in agy CLI account into the plugin vault"
                disabled={busyKey !== null}
                onPress={() => runAction('import', () => plugin.request('accounts.importCurrentAgy'))}
              >
                {busyKey === 'import' ? 'Importing…' : 'Import Current AGY'}
              </Button>
            </Row>

            {oauth ? (
              <Card
                title="Connect Google Account"
                description="Sign in with Google (use Incognito to add another account). The plugin captures the callback automatically."
              >
                <Stack gap="sm">
                  <Row gap="xs" wrap>
                    <Button size="xs" variant="solid" tone="accent" icon="open-external" onPress={openOAuthInBrowser}>
                      Open in Browser
                    </Button>
                    <Button size="xs" variant="ghost" onPress={cancelOAuthFlow}>
                      Cancel
                    </Button>
                  </Row>
                  <Text size="xs" muted>
                    Or copy this URL into an Incognito browser window:
                  </Text>
                  <Code block>{oauth.authUrl}</Code>
                  <Input
                    label="Manual callback URL or code (optional)"
                    placeholder="Paste http://127.0.0.1:.../auth/callback?code=... if needed"
                    value={manualCallback}
                    onChange={(v) => set(manualCallbackAtom, v)}
                    onSubmit={completeManualOAuth}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!manualCallback.trim() || busyKey !== null}
                    onPress={completeManualOAuth}
                  >
                    Complete Sign-In
                  </Button>
                </Stack>
              </Card>
            ) : null}

            {!snap.agyPool.available ? (
              <EmptyState
                icon="zap"
                title="No AGY accounts saved yet"
                description="Click 'Add Google Account' to sign in via OAuth or 'Import Current AGY' to capture your current agy CLI login — no external manager needed."
              />
            ) : (
              snap.agyPool.accounts.map((acc) => (
                <AgyPoolRow
                  key={acc.email}
                  account={acc}
                  isBest={snap.agyPool.bestEmail === acc.email}
                  busyKey={busyKey}
                />
              ))
            )}
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
