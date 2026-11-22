// Declarative Orca sidebar panel: switches Orca managed agents, `agy` CLI, and built-in OAuth Vault on the fly.
import {
  atom,
  Button,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  Input,
  plugin,
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
import {
  AgyEmptyState,
  AgyPoolRow,
  DiagnosticsSection,
  LaunchLockBanner,
  OAuthConnectCard,
  ProviderSection,
  UpdateBanner
} from './panel-components'
import type { AccountsSnapshot, OAuthStartResult, SwitchResult } from './protocol'

const snapshotAtom = atom<AccountsSnapshot | null>(null)
const busyKeyAtom = atom<string | null>(null)
const feedbackAtom = atom<{ tone: Tone; text: string } | null>(null)
const activeTabAtom = atom('activeTab', 'orca', { persist: 'plugin' })
const oauthPendingAtom = atom<OAuthStartResult | null>(null)
const manualCallbackAtom = atom('')
const agyFilterAtom = atom('')

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

async function applyPluginUpdate(): Promise<void> {
  if (read(busyKeyAtom) !== null) return
  set(busyKeyAtom, 'update-apply')
  set(feedbackAtom, { tone: 'neutral', text: 'Updating plugin via Orca CLI…' })
  try {
    const res = await plugin.request('accounts.applyUpdate')
    set(snapshotAtom, res.snapshot)
    set(feedbackAtom, { tone: res.ok ? 'success' : 'warning', text: res.message })
  } catch (error) {
    // Orca may restart the plugin worker mid-call while replacing the installed version.
    await new Promise((r) => setTimeout(r, 900))
    try {
      const fresh = await plugin.request('accounts.snapshot', { refreshQuotas: false })
      set(snapshotAtom, fresh)
      set(feedbackAtom, {
        tone: 'success',
        text: `Plugin updated (v${fresh.update?.currentVersion ?? 'latest'}) and reloaded.`
      })
    } catch {
      set(feedbackAtom, {
        tone: 'danger',
        text: error instanceof Error ? error.message : 'Plugin update failed'
      })
    }
  } finally {
    set(busyKeyAtom, null)
  }
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

export default function Panel() {
  const snap = read(snapshotAtom)
  const busyKey = read(busyKeyAtom)
  const feedback = read(feedbackAtom)
  const tab = read(activeTabAtom)
  const oauth = read(oauthPendingAtom)
  const manualCallback = read(manualCallbackAtom)
  const agyFilter = read(agyFilterAtom)

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
  const filterQuery = agyFilter.trim().toLowerCase()
  const filteredAgyAccounts = filterQuery
    ? snap.agyPool.accounts.filter(
        (acc) => acc.email.toLowerCase().includes(filterQuery) || acc.name.toLowerCase().includes(filterQuery)
      )
    : snap.agyPool.accounts

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

      {snap.orcaLaunchLock ? (
        <LaunchLockBanner
          lock={snap.orcaLaunchLock}
          busyKey={busyKey}
          onRevertToOrcaSelected={(accountId) =>
            runAction(`orca:antigravity:${accountId}`, () =>
              plugin.request('accounts.selectOrca', { agent: 'antigravity', account: accountId })
            )
          }
        />
      ) : null}

      {snap.update ? (
        <UpdateBanner
          update={snap.update}
          busyKey={busyKey}
          onApplyUpdate={() => void applyPluginUpdate()}
          onOpenRepo={() => {
            void shell.openExternal(snap.update!.repoUrl).catch(() => undefined)
          }}
          onDismiss={() => {
            const ver = snap.update?.latestVersion
            if (!ver || read(busyKeyAtom) !== null) return
            set(busyKeyAtom, 'update-dismiss')
            void plugin
              .request('accounts.dismissUpdate', { version: ver })
              .then((next) => set(snapshotAtom, next))
              .catch(() => undefined)
              .finally(() => set(busyKeyAtom, null))
          }}
        />
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
                <ProviderSection
                  key={provider.agent}
                  provider={provider}
                  busyKey={busyKey}
                  onSelect={(key, agent, account) =>
                    runAction(key, () => plugin.request('accounts.selectOrca', { agent, account }))
                  }
                />
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

            {snap.agyPool.error ? (
              <Callout tone="warning" title="AGY Quota Polling" icon="warning">
                {snap.agyPool.error}
              </Callout>
            ) : null}

            {oauth ? (
              <OAuthConnectCard
                oauth={oauth}
                manualCallback={manualCallback}
                busyKey={busyKey}
                onOpenBrowser={openOAuthInBrowser}
                onCancel={cancelOAuthFlow}
                onCallbackChange={(v) => set(manualCallbackAtom, v)}
                onCompleteManual={completeManualOAuth}
              />
            ) : null}

            {snap.agyPool.accounts.length > 3 ? (
              <Input
                label="Filter AGY accounts"
                labelHidden
                type="search"
                placeholder="Filter by email or name…"
                value={agyFilter}
                onChange={(v) => set(agyFilterAtom, v)}
              />
            ) : null}

            {!snap.agyPool.available ? (
              <AgyEmptyState />
            ) : filteredAgyAccounts.length === 0 ? (
              <EmptyState
                icon="search"
                title="No matching accounts"
                description={`No AGY account matched "${agyFilter}".`}
              />
            ) : (
              filteredAgyAccounts.map((acc) => (
                <AgyPoolRow
                  key={acc.email}
                  account={acc}
                  isBest={snap.agyPool.bestEmail === acc.email}
                  busyKey={busyKey}
                  onSwitch={(key, email) => runAction(key, () => plugin.request('accounts.selectAgyPool', { email }))}
                  onRemove={(key, email) =>
                    runAction(key, () => plugin.request('accounts.removeVaultAccount', { email }))
                  }
                />
              ))
            )}
          </Stack>
        </Tab>
      </Tabs>

      <DiagnosticsSection
        snap={snap}
        busyKey={busyKey}
        onApplyUpdate={() => void applyPluginUpdate()}
        onCheckUpdate={() => {
          if (read(busyKeyAtom) !== null) return
          set(busyKeyAtom, 'update-check')
          void plugin
            .request('accounts.checkUpdate')
            .then((next) => {
              set(snapshotAtom, next)
              set(feedbackAtom, {
                tone: next.update?.hasUpdate ? 'accent' : next.update?.error ? 'warning' : 'success',
                text: next.update?.hasUpdate
                  ? `Update available: v${next.update.latestVersion} (current v${next.update.currentVersion})`
                  : next.update?.error
                    ? `Update check failed: ${next.update.error}`
                    : `You are on the latest version (v${next.update?.currentVersion ?? 'current'})`
              })
            })
            .catch((error) => {
              set(feedbackAtom, {
                tone: 'danger',
                text: error instanceof Error ? error.message : 'Update check failed'
              })
            })
            .finally(() => set(busyKeyAtom, null))
        }}
      />
    </Stack>
  )
}
