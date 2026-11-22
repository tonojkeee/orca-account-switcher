// Modular declarative UI components for the Account Switcher sidebar panel.
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Collapsible,
  EmptyState,
  IconButton,
  Input,
  KeyValue,
  Progress,
  RelativeTime,
  Row,
  Stack,
  Text,
  type Tone
} from 'orca'
import type {
  AccountsSnapshot,
  AgyPoolAccount,
  OAuthStartResult,
  OrcaAgentKind,
  OrcaLaunchLock,
  OrcaManagedAccount,
  OrcaProviderState,
  PluginUpdateInfo
} from './protocol'

export function toneForQuota(pct: number | null): Tone {
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

export function QuotaBar({
  label,
  value,
  resetsAt
}: {
  label: string
  value: number
  resetsAt?: number | null
}) {
  const hasFutureReset = typeof resetsAt === 'number' && resetsAt > Date.now()
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Text size="xs" muted truncate>
          {label}
        </Text>
        <Row gap="xs" align="center">
          {hasFutureReset ? (
            <Text size="xs" muted>
              in <RelativeTime at={resetsAt} format="duration" />
            </Text>
          ) : null}
          <Badge tone={toneForQuota(value)}>{value}%</Badge>
        </Row>
      </Row>
      <Progress label={label} labelHidden value={value} />
    </Stack>
  )
}

export function OrcaAccountRow({
  agent,
  account,
  busyKey,
  onSelect
}: {
  agent: OrcaAgentKind
  account: OrcaManagedAccount
  busyKey: string | null
  onSelect: (key: string, agent: OrcaAgentKind, accountId: string) => void
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
            onPress={() => onSelect(key, agent, account.id)}
          >
            {busyKey === key ? 'Switching…' : account.active ? 'Current' : 'Use'}
          </Button>
        </Row>
        {account.buckets.length > 0 ? (
          <Stack gap="xs">
            {account.buckets.slice(0, 8).map((bucket) => (
              <QuotaBar
                key={bucket.label}
                label={bucket.label}
                value={bucket.remainingPercent}
                resetsAt={bucket.resetsAt}
              />
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Box>
  )
}

export function ProviderSection({
  provider,
  busyKey,
  onSelect
}: {
  provider: OrcaProviderState
  busyKey: string | null
  onSelect: (key: string, agent: OrcaAgentKind, accountId: string) => void
}) {
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
              onPress={() => onSelect(sysKey, provider.agent, 'system')}
            >
              {busyKey === sysKey ? 'Switching…' : 'Use system'}
            </Button>
          </Row>
        ) : null}
        {provider.accounts.map((acc) => (
          <OrcaAccountRow
            key={acc.id}
            agent={provider.agent}
            account={acc}
            busyKey={busyKey}
            onSelect={onSelect}
          />
        ))}
      </Stack>
    </Card>
  )
}

export function AgyPoolRow({
  account,
  isBest,
  busyKey,
  onSwitch,
  onRemove
}: {
  account: AgyPoolAccount
  isBest: boolean
  busyKey: string | null
  onSwitch: (key: string, email: string) => void
  onRemove: (key: string, email: string) => void
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
                onPress={() => onRemove(delKey, account.email)}
              />
            ) : null}
            <Button
              size="xs"
              variant={account.active ? 'ghost' : 'solid'}
              tone={account.active ? 'neutral' : 'accent'}
              disabled={account.active || busyKey !== null}
              onPress={() => onSwitch(key, account.email)}
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
            {account.gemini5h !== null ? (
              <QuotaBar
                label="Gemini 5h"
                value={Math.round(account.gemini5h)}
                resetsAt={account.gemini5hResetsAt}
              />
            ) : null}
            {account.geminiWeekly !== null ? (
              <QuotaBar
                label="Gemini Weekly"
                value={Math.round(account.geminiWeekly)}
                resetsAt={account.geminiWeeklyResetsAt}
              />
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

export function OAuthConnectCard({
  oauth,
  manualCallback,
  busyKey,
  onOpenBrowser,
  onCancel,
  onCallbackChange,
  onCompleteManual
}: {
  oauth: OAuthStartResult
  manualCallback: string
  busyKey: string | null
  onOpenBrowser: () => void
  onCancel: () => void
  onCallbackChange: (value: string) => void
  onCompleteManual: () => void
}) {
  return (
    <Card
      title="Connect Google Account"
      description="Sign in with Google (use Incognito to add another account). The plugin captures the callback automatically."
    >
      <Stack gap="sm">
        <Row gap="xs" wrap>
          <Button size="xs" variant="solid" tone="accent" icon="open-external" onPress={onOpenBrowser}>
            Open in Browser
          </Button>
          <Button size="xs" variant="ghost" onPress={onCancel}>
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
          onChange={onCallbackChange}
          onSubmit={onCompleteManual}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={!manualCallback.trim() || busyKey !== null}
          onPress={onCompleteManual}
        >
          Complete Sign-In
        </Button>
      </Stack>
    </Card>
  )
}

export function LaunchLockBanner({
  lock,
  busyKey,
  onRevertToOrcaSelected
}: {
  lock: OrcaLaunchLock
  busyKey: string | null
  onRevertToOrcaSelected: (accountId: string) => void
}) {
  return (
    <Callout tone="warning" title="Orca terminal launch lock (Antigravity)" icon="warning">
      <Stack gap="xs">
        <Text size="xs">
          Orca is pinned to {lock.selectedLabel}, while agy CLI is on {lock.activeEmail ?? 'another account'}.
          Launching agy in an Orca terminal will fail unless both match.
        </Text>
        <Text size="xs" muted>
          Fix: open Orca Settings &gt; AI Provider Accounts &gt; Antigravity and save the current login (or remove
          pinned Antigravity accounts), or switch back below.
        </Text>
        <Row gap="xs" wrap>
          <Button
            size="xs"
            variant="outline"
            disabled={busyKey !== null}
            onPress={() => onRevertToOrcaSelected(lock.selectedAccountId)}
          >
            {busyKey === `orca:antigravity:${lock.selectedAccountId}`
              ? 'Switching…'
              : `Use ${lock.selectedLabel}`}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

export function UpdateBanner({
  update,
  busyKey,
  onApplyUpdate,
  onOpenRepo,
  onDismiss
}: {
  update: PluginUpdateInfo
  busyKey: string | null
  onApplyUpdate: () => void
  onOpenRepo: () => void
  onDismiss: () => void
}) {
  if (!update.hasUpdate || update.dismissed || !update.latestVersion) return null
  return (
    <Callout tone="accent" title={`Update available: v${update.latestVersion}`} icon="download">
      <Stack gap="xs">
        <Text size="xs">
          New version v{update.latestVersion} is available (installed v{update.currentVersion}).
        </Text>
        <Row gap="xs" wrap>
          <Button
            size="xs"
            variant="solid"
            tone="accent"
            icon="download"
            disabled={busyKey !== null}
            onPress={onApplyUpdate}
          >
            {busyKey === 'update-apply' ? 'Updating…' : 'Update now'}
          </Button>
          <Button size="xs" variant="outline" icon="open-external" onPress={onOpenRepo}>
            GitHub
          </Button>
          <Button size="xs" variant="ghost" disabled={busyKey !== null} onPress={onDismiss}>
            Dismiss
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

export function DiagnosticsSection({
  snap,
  busyKey,
  onCheckUpdate,
  onApplyUpdate
}: {
  snap: AccountsSnapshot
  busyKey: string | null
  onCheckUpdate: () => void
  onApplyUpdate: () => void
}) {
  const diag = snap.diagnostics
  const update = snap.update
  const versionText = update
    ? update.hasUpdate && update.latestVersion
      ? `v${update.currentVersion} -> v${update.latestVersion} available`
      : `v${update.currentVersion} (up to date)`
    : 'unknown'

  return (
    <Collapsible title="Runtime diagnostics" description="Detected CLIs, OAuth client source, and version">
      <Stack gap="sm">
        <KeyValue
          label="Environment diagnostics"
          items={[
            { label: 'Version', value: versionText, tone: update?.hasUpdate ? 'accent' : 'neutral', code: true },
            { label: 'Platform', value: snap.platform, code: true },
            {
              label: 'Orca CLI',
              value: diag?.orcaCliPath ?? (snap.orcaCliFound ? 'detected' : 'not found'),
              tone: snap.orcaCliFound ? 'success' : 'warning',
              code: true
            },
            {
              label: 'AGY CLI',
              value: diag?.agyCliPath ?? 'not found',
              tone: diag?.agyCliPath ? 'success' : 'neutral',
              code: true
            },
            { label: 'AGY Tools', value: diag?.agyToolsCliPath ?? 'optional (not installed)', code: true },
            {
              label: 'OAuth Client',
              value: diag?.oauthClientSource ?? (snap.agyPool.oauthReady ? 'ready' : 'not configured'),
              tone: snap.agyPool.oauthReady ? 'success' : 'warning',
              code: true
            },
            { label: 'Active AGY', value: snap.agyPool.activeEmail ?? 'none' }
          ]}
        />
        <Row gap="xs" align="center" wrap>
          <Button
            size="xs"
            variant="outline"
            icon="refresh"
            disabled={busyKey !== null}
            onPress={onCheckUpdate}
          >
            {busyKey === 'update-check' ? 'Checking…' : 'Check updates'}
          </Button>
          <Button
            size="xs"
            variant={update?.hasUpdate ? 'solid' : 'outline'}
            tone={update?.hasUpdate ? 'accent' : 'neutral'}
            icon="download"
            disabled={busyKey !== null}
            onPress={onApplyUpdate}
          >
            {busyKey === 'update-apply'
              ? 'Updating…'
              : update?.hasUpdate && update.latestVersion
                ? `Update to v${update.latestVersion}`
                : 'Update plugin'}
          </Button>
          {update?.error ? (
            <Text size="xs" tone="warning">
              Update check: {update.error}
            </Text>
          ) : null}
        </Row>
      </Stack>
    </Collapsible>
  )
}

export function AgyEmptyState() {
  return (
    <EmptyState
      icon="zap"
      title="No AGY accounts saved yet"
      description="Click 'Add Google Account' to sign in via OAuth or 'Import Current AGY' to capture your current agy CLI login — no external manager needed."
    />
  )
}
