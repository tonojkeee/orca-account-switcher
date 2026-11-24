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

export function sourceBadgeLabel(source: AgyPoolAccount['source']): string {
  if (source === 'both') return 'Vault + Tools'
  if (source === 'vault') return 'Vault'
  return 'AGY Tools'
}

export function ActiveSpotlightStrip({
  activeAgy,
  activeOrcaAg,
  spotlightEffPct,
  hasArgon,
  argonPct
}: {
  activeAgy?: AgyPoolAccount | null
  activeOrcaAg?: OrcaManagedAccount | null
  spotlightEffPct: number | null
  hasArgon: boolean
  argonPct: number | null
}) {
  if (activeAgy) {
    return (
      <Box padding="sm" background="card" border="accent" radius="md">
        <Row justify="between" align="center" gap="xs" wrap>
          <Row gap="xs" align="center" wrap>
            <Text size="sm" weight="semibold" truncate>
              {activeAgy.name ? `${activeAgy.name} (${activeAgy.email})` : activeAgy.email}
            </Text>
            <Badge tone="success">Active</Badge>
            {spotlightEffPct !== null ? (
              <Badge tone={toneForQuota(spotlightEffPct)}>{`${spotlightEffPct}%`}</Badge>
            ) : null}
            {hasArgon && argonPct !== null ? (
              <Badge tone={toneForQuota(argonPct)}>{`Argon ${argonPct}%`}</Badge>
            ) : null}
          </Row>
        </Row>
      </Box>
    )
  }
  if (activeOrcaAg) {
    return (
      <Box padding="sm" background="card" border="accent" radius="md">
        <Row justify="between" align="center" gap="xs" wrap>
          <Row gap="xs" align="center" wrap>
            <Text size="sm" weight="semibold" truncate>
              {activeOrcaAg.label}
            </Text>
            <Badge tone="success">Active</Badge>
            {spotlightEffPct !== null ? (
              <Badge tone={toneForQuota(spotlightEffPct)}>{`${spotlightEffPct}%`}</Badge>
            ) : null}
          </Row>
        </Row>
      </Box>
    )
  }
  return null
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
    <Collapsible
      title="Runtime diagnostics"
      description="Detected CLIs, OAuth client source, and version"
      defaultOpen={false}
    >
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
