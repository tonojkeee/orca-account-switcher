// Declarative Orca sidebar panel (v0.3.0): scan-first, zero-clutter account switcher for Orca + agy CLI + Google Vault.
import {
  atom,
  Badge,
  Box,
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
  Toolbar,
  type PanelContext,
  type Tone
} from 'orca'
import {
  ActiveSpotlightStrip,
  AgyEmptyState,
  DiagnosticsSection,
  LaunchLockBanner,
  OAuthConnectCard,
  toneForQuota,
  UpdateBanner
} from './panel-components'
import { AgyAccountCard, ProviderSectionFlat } from './panel-cards'
import type { AccountsSnapshot, OAuthStartResult, SwitchResult } from './protocol'

const snapshotAtom = atom<AccountsSnapshot | null>(null)
const busyKeyAtom = atom<string | null>(null)
const feedbackAtom = atom<{ tone: Tone; text: string } | null>(null)
const activeTabAtom = atom('activeTab', 'orca', { persist: 'plugin' })
const oauthPendingAtom = atom<OAuthStartResult | null>(null)
const manualCallbackAtom = atom('')
const searchQueryAtom = atom('')
const confirmDeleteAtom = atom<{ tab: 'orca' | 'agy'; id: string } | null>(null)

async function refreshAccounts(): Promise<void> {
  if (read(busyKeyAtom) !== null) return
  set(confirmDeleteAtom, null)
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
  set(confirmDeleteAtom, null)
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
  set(confirmDeleteAtom, null)
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
  set(confirmDeleteAtom, null)
  set(busyKeyAtom, 'update-apply')
  set(feedbackAtom, { tone: 'neutral', text: 'Updating plugin via Orca CLI…' })
  try {
    const res = await plugin.request('accounts.applyUpdate')
    set(snapshotAtom, res.snapshot)
    set(feedbackAtom, { tone: res.ok ? 'success' : 'warning', text: res.message })
  } catch (error) {
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
  const searchQuery = read(searchQueryAtom)
  const confirmDelete = read(confirmDeleteAtom)

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

  const configuredProviders = snap.providers.filter(
    (p) => p.accounts.length > 0 || p.systemDefaultLabel !== null
  )
  const emptyProviders = snap.providers.filter(
    (p) => p.accounts.length === 0 && p.systemDefaultLabel === null
  )

  const orcaCount = snap.providers.reduce((n, p) => n + p.accounts.length, 0)
  const agyCount = snap.agyPool.accounts.length
  const totalCount = orcaCount + agyCount

  // Best quota calculation
  const bestAcc = snap.agyPool.accounts.find((a) => a.email === snap.agyPool.bestEmail)
  const bestPct =
    bestAcc?.effectiveGemini !== null && bestAcc?.effectiveGemini !== undefined
      ? Math.round(bestAcc.effectiveGemini)
      : null
  const bestButtonText = bestPct !== null ? `Best · ${bestPct}%` : 'Best'
  const bestAvailable =
    snap.agyPool.available ||
    (snap.providers.find((p) => p.agent === 'antigravity')?.accounts.length ?? 0) > 1

  // Active Spotlight
  const activeAgy = snap.agyPool.accounts.find((a) => a.active)
  const activeOrcaAg = snap.providers
    .find((p) => p.agent === 'antigravity')
    ?.accounts.find((a) => a.active)

  const spotlightEffPct =
    activeAgy && activeAgy.effectiveGemini !== null && activeAgy.effectiveGemini !== undefined
      ? Math.round(activeAgy.effectiveGemini)
      : activeOrcaAg?.effectiveRemaining !== null && activeOrcaAg?.effectiveRemaining !== undefined
        ? Math.round(activeOrcaAg.effectiveRemaining)
        : null

  const hasArgon = activeAgy && activeAgy.argonWeekly !== null && activeAgy.argonWeekly !== undefined
  const argonPct = hasArgon ? Math.round(activeAgy.argonWeekly!) : null

  // Universal query filtering
  const query = searchQuery.trim().toLowerCase()
  const filteredAgyAccounts = query
    ? snap.agyPool.accounts.filter(
        (acc) =>
          acc.email.toLowerCase().includes(query) || acc.name.toLowerCase().includes(query)
      )
    : snap.agyPool.accounts

  const antigravityProvider = snap.providers.find((p) => p.agent === 'antigravity')
  const totalAntigravityCount = antigravityProvider?.accounts.length ?? 0

  return (
    <Stack gap="md">
      {/* 1. Header with negative-time fix & Toolbar */}
      <Row justify="between" align="center" gap="xs">
        <Stack gap="none">
          <Heading level={2}>Accounts</Heading>
          <Text size="xs" muted>
            Updated <RelativeTime at={Math.min(snap.fetchedAt, Date.now())} format="short" /> · {totalCount} accounts
          </Text>
        </Stack>
        <Toolbar label="Header actions" gap="xs">
          {bestAvailable ? (
            <Button
              size="xs"
              variant="outline"
              tone="accent"
              icon="zap"
              tooltip="Switch agy CLI + Orca to highest remaining Gemini quota"
              disabled={busyKey !== null}
              onPress={() => runAction('best', () => plugin.request('accounts.switchBestAgy'))}
            >
              {busyKey === 'best' ? 'Switching…' : bestButtonText}
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
        </Toolbar>
      </Row>

      {/* 2. Active Spotlight Strip */}
      <ActiveSpotlightStrip
        activeAgy={activeAgy}
        activeOrcaAg={activeOrcaAg}
        spotlightEffPct={spotlightEffPct}
        hasArgon={Boolean(hasArgon)}
        argonPct={argonPct}
      />

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

      {/* 3. Tabs & Content */}
      <Tabs
        label="Account source"
        value={tab}
        onChange={(next) => {
          set(confirmDeleteAtom, null)
          set(activeTabAtom, next)
        }}
      >
        <Tab value="orca" label="Orca Agents" icon="agent">
          <Stack gap="sm">
            {orcaCount > 3 ? (
              <Input
                label="Search accounts"
                labelHidden
                type="search"
                placeholder="Search Orca accounts…"
                value={searchQuery}
                onChange={(v) => {
                  set(confirmDeleteAtom, null)
                  set(searchQueryAtom, v)
                }}
              />
            ) : null}

            {configuredProviders.length === 0 ? (
              <EmptyState
                icon="agent"
                title="No Orca agent accounts"
                description="Add accounts in Orca Settings > AI Provider Accounts or via `orca account add`."
              />
            ) : (
              configuredProviders.map((provider) => {
                const provAccounts = query
                  ? provider.accounts.filter(
                      (a) =>
                        a.label.toLowerCase().includes(query) ||
                        (a.email && a.email.toLowerCase().includes(query))
                    )
                  : provider.accounts
                if (query && provAccounts.length === 0) return null
                return (
                  <ProviderSectionFlat
                    key={provider.agent}
                    provider={{ ...provider, accounts: provAccounts }}
                    busyKey={busyKey}
                    confirmDeleteId={confirmDelete?.tab === 'orca' ? confirmDelete.id : null}
                    isLastActiveProvider={totalAntigravityCount <= 1}
                    onSelect={(key, agent, account) =>
                      runAction(key, () =>
                        plugin.request('accounts.selectOrca', { agent, account })
                      )
                    }
                    onStartDelete={(id) => set(confirmDeleteAtom, { tab: 'orca', id })}
                    onConfirmDelete={(agent, accountId) =>
                      runAction(`orca-rm:${agent}:${accountId}`, () =>
                        plugin.request('accounts.removeOrcaAccount', { agent, account: accountId })
                      )
                    }
                    onCancelDelete={() => set(confirmDeleteAtom, null)}
                  />
                )
              })
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
                value={searchQuery}
                onChange={(v) => {
                  set(confirmDeleteAtom, null)
                  set(searchQueryAtom, v)
                }}
              />
            ) : null}

            {!snap.agyPool.available ? (
              <AgyEmptyState />
            ) : filteredAgyAccounts.length === 0 ? (
              <EmptyState
                icon="search"
                title="No matching accounts"
                description={`No AGY account matched "${searchQuery}".`}
              />
            ) : (
              filteredAgyAccounts.map((acc) => {
                const surviving = snap.agyPool.accounts.filter(
                  (a) => a.email.toLowerCase() !== acc.email.toLowerCase()
                )
                const fallback =
                  surviving.find((a) => a.email === snap.agyPool.bestEmail) ?? surviving[0]

                return (
                  <AgyAccountCard
                    key={acc.email}
                    account={acc}
                    isBest={snap.agyPool.bestEmail === acc.email}
                    isLastActive={acc.active && snap.agyPool.accounts.length <= 1}
                    fallbackEmail={fallback?.email ?? null}
                    busyKey={busyKey}
                    confirmDeleteEmail={confirmDelete?.tab === 'agy' ? confirmDelete.id : null}
                    onSwitch={(key, email) =>
                      runAction(key, () => plugin.request('accounts.selectAgyPool', { email }))
                    }
                    onStartDelete={(email) => set(confirmDeleteAtom, { tab: 'agy', id: email })}
                    onConfirmDelete={(email) =>
                      runAction(`agy-rm:${email}`, () =>
                        plugin.request('accounts.removeAgyAccount', { email })
                      )
                    }
                    onCancelDelete={() => set(confirmDeleteAtom, null)}
                  />
                )
              })
            )}
          </Stack>
        </Tab>
      </Tabs>

      {/* 4. Diagnostics in Collapsible (defaultOpen=false) */}
      <DiagnosticsSection
        snap={snap}
        busyKey={busyKey}
        onApplyUpdate={() => void applyPluginUpdate()}
        onCheckUpdate={() => {
          if (read(busyKeyAtom) !== null) return
          set(confirmDeleteAtom, null)
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
