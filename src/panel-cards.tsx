// Flat, compact account cards and quota grid components for the Account Switcher panel.
import {
  Badge,
  Box,
  Button,
  Grid,
  IconButton,
  Progress,
  RelativeTime,
  Row,
  Stack,
  Text
} from 'orca'
import type {
  AgyPoolAccount,
  OrcaAgentKind,
  OrcaManagedAccount,
  OrcaProviderState,
  QuotaBucket
} from './protocol'
import { sourceBadgeLabel, toneForQuota } from './panel-components'

export function CompactQuotaCell({
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
    <Stack gap="none">
      <Row justify="between" align="center" gap="xs">
        <Text size="xs" muted truncate>
          {label}
        </Text>
        <Row gap="xs" align="center">
          {hasFutureReset ? (
            <Text size="xs" muted>
              <RelativeTime at={resetsAt} format="duration" />
            </Text>
          ) : null}
          <Text size="xs" weight="semibold" tone={toneForQuota(value)}>
            {`${value}%`}
          </Text>
        </Row>
      </Row>
      <Progress label={label} labelHidden value={value} />
    </Stack>
  )
}

function shortenBucketLabel(label: string): string {
  const lower = label.toLowerCase()
  if (lower.includes('gemini') && lower.includes('5h')) return 'Gem 5h'
  if (lower.includes('gemini') && lower.includes('week')) return 'Gem Wk'
  if (lower.includes('argon') && lower.includes('week')) return 'Argon Wk'
  if (lower.includes('argon') && lower.includes('5h')) return 'Argon 5h'
  if (lower.includes('claude') || lower.includes('gpt')) return 'Cld Wk'
  if (lower.includes('session') || lower.includes('5h')) return '5h'
  if (lower.includes('weekly')) return 'Weekly'
  return label
}

export function OrcaAccountCard({
  agent,
  account,
  busyKey,
  confirmDeleteId,
  isLastActive,
  onSelect,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete
}: {
  agent: OrcaAgentKind
  account: OrcaManagedAccount
  busyKey: string | null
  confirmDeleteId: string | null
  isLastActive: boolean
  onSelect: (key: string, agent: OrcaAgentKind, accountId: string) => void
  onStartDelete: (id: string) => void
  onConfirmDelete: (agent: OrcaAgentKind, accountId: string) => void
  onCancelDelete: () => void
}) {
  const key = `orca:${agent}:${account.id}`
  const isConfirming = confirmDeleteId === account.id
  const deleteDisabled = isLastActive || busyKey !== null
  const deleteTooltip = isLastActive
    ? 'Cannot remove the last active account. Add another account first.'
    : `Remove ${account.label}`

  return (
    <Box
      padding="sm"
      border={account.active ? 'accent' : true}
      radius="md"
      background={account.active ? 'card' : 'none'}
    >
      <Stack gap="xs">
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
          <Row gap="xs" align="center">
            <IconButton
              icon="delete"
              label={`Remove ${account.label}`}
              tooltip={deleteTooltip}
              variant="ghost"
              tone="danger"
              size="xs"
              disabled={deleteDisabled}
              onPress={() => onStartDelete(account.id)}
            />
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
        </Row>

        {isConfirming ? (
          <Box padding="sm" radius="md" border="danger" background="danger">
            <Stack gap="xs">
              <Text size="xs" weight="semibold" tone="danger">
                {`Remove ${account.label}?`}
              </Text>
              <Row gap="xs">
                <Button
                  size="xs"
                  tone="danger"
                  variant="solid"
                  disabled={busyKey !== null}
                  onPress={() => onConfirmDelete(agent, account.id)}
                >
                  Confirm
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busyKey !== null}
                  onPress={onCancelDelete}
                >
                  Cancel
                </Button>
              </Row>
            </Stack>
          </Box>
        ) : null}

        {account.buckets.length > 0 ? (
          <Grid columns={2} gap="xs">
            {account.buckets.slice(0, 4).map((bucket) => (
              <CompactQuotaCell
                key={bucket.label}
                label={shortenBucketLabel(bucket.label)}
                value={bucket.remainingPercent}
                resetsAt={bucket.resetsAt}
              />
            ))}
          </Grid>
        ) : null}
      </Stack>
    </Box>
  )
}

export function AgyAccountCard({
  account,
  isBest,
  isLastActive,
  fallbackEmail,
  busyKey,
  confirmDeleteEmail,
  onSwitch,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete
}: {
  account: AgyPoolAccount
  isBest: boolean
  isLastActive: boolean
  fallbackEmail: string | null
  busyKey: string | null
  confirmDeleteEmail: string | null
  onSwitch: (key: string, email: string) => void
  onStartDelete: (email: string) => void
  onConfirmDelete: (email: string) => void
  onCancelDelete: () => void
}) {
  const key = `agy:${account.email}`
  const isConfirming = confirmDeleteEmail === account.email
  const deleteDisabled = isLastActive || busyKey !== null
  const deleteTooltip = isLastActive
    ? 'Cannot remove the last active account. Add another account first.'
    : `Remove ${account.email}`

  // Strict invariant: only render Argon when explicitly present
  const hasArgonWeekly = account.argonWeekly !== null && account.argonWeekly !== undefined
  const hasArgon5h = account.argon5h !== null && account.argon5h !== undefined

  return (
    <Box
      padding="sm"
      border={account.active ? 'accent' : true}
      radius="md"
      background={account.active ? 'card' : 'none'}
    >
      <Stack gap="xs">
        <Row justify="between" align="center" gap="xs">
          <Stack gap="none">
            <Row gap="xs" align="center" wrap>
              <Text size="sm" weight="semibold" truncate>
                {account.email}
              </Text>
              {account.active ? <Badge tone="success">Active</Badge> : null}
              {isBest ? <Badge tone="accent">Best</Badge> : null}
            </Row>
            <Text size="xs" muted truncate>
              {account.name
                ? `${account.name} · ${sourceBadgeLabel(account.source)}`
                : sourceBadgeLabel(account.source)}
            </Text>
          </Stack>
          <Row gap="xs" align="center">
            <IconButton
              icon="delete"
              label={`Remove ${account.email}`}
              tooltip={deleteTooltip}
              variant="ghost"
              tone="danger"
              size="xs"
              disabled={deleteDisabled}
              onPress={() => onStartDelete(account.email)}
            />
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

        {isConfirming ? (
          account.active ? (
            <Box padding="sm" radius="md" border="warning" background="warning">
              <Stack gap="xs">
                <Text size="xs" weight="semibold" tone="warning">
                  {`Active account! Auto-switch to ${fallbackEmail ?? 'next account'} & remove?`}
                </Text>
                <Row gap="xs">
                  <Button
                    size="xs"
                    tone="warning"
                    variant="solid"
                    disabled={busyKey !== null}
                    onPress={() => onConfirmDelete(account.email)}
                  >
                    Confirm
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyKey !== null}
                    onPress={onCancelDelete}
                  >
                    Cancel
                  </Button>
                </Row>
              </Stack>
            </Box>
          ) : (
            <Box padding="sm" radius="md" border="danger" background="danger">
              <Stack gap="xs">
                <Text size="xs" weight="semibold" tone="danger">
                  {`Remove ${account.email}?`}
                </Text>
                <Row gap="xs">
                  <Button
                    size="xs"
                    tone="danger"
                    variant="solid"
                    disabled={busyKey !== null}
                    onPress={() => onConfirmDelete(account.email)}
                  >
                    Confirm
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyKey !== null}
                    onPress={onCancelDelete}
                  >
                    Cancel
                  </Button>
                </Row>
              </Stack>
            </Box>
          )
        ) : null}

        {account.error ? (
          <Text size="xs" tone="danger">
            {account.error}
          </Text>
        ) : (
          <Grid columns={2} gap="xs">
            {account.gemini5h !== null ? (
              <CompactQuotaCell
                label="Gem 5h"
                value={Math.round(account.gemini5h)}
                resetsAt={account.gemini5hResetsAt}
              />
            ) : null}
            {account.geminiWeekly !== null ? (
              <CompactQuotaCell
                label="Gem Wk"
                value={Math.round(account.geminiWeekly)}
                resetsAt={account.geminiWeeklyResetsAt}
              />
            ) : null}
            {hasArgonWeekly ? (
              <CompactQuotaCell
                label="Argon Wk"
                value={Math.round(account.argonWeekly!)}
                resetsAt={account.argonWeeklyResetsAt}
              />
            ) : null}
            {hasArgon5h ? (
              <CompactQuotaCell
                label="Argon 5h"
                value={Math.round(account.argon5h!)}
                resetsAt={account.argon5hResetsAt}
              />
            ) : null}
            {account.claudeWeekly !== null ? (
              <CompactQuotaCell label="Cld Wk" value={Math.round(account.claudeWeekly)} />
            ) : null}
          </Grid>
        )}
      </Stack>
    </Box>
  )
}

export function ProviderSectionFlat({
  provider,
  busyKey,
  confirmDeleteId,
  isLastActiveProvider,
  onSelect,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete
}: {
  provider: OrcaProviderState
  busyKey: string | null
  confirmDeleteId: string | null
  isLastActiveProvider: boolean
  onSelect: (key: string, agent: OrcaAgentKind, accountId: string) => void
  onStartDelete: (id: string) => void
  onConfirmDelete: (agent: OrcaAgentKind, accountId: string) => void
  onCancelDelete: () => void
}) {
  const usingSystem = provider.supportsSystemDefault && provider.activeAccountId === null
  const sysKey = `orca:${provider.agent}:system`

  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Text size="xs" weight="semibold" muted>
          {`${provider.title.toUpperCase()} · ${provider.accounts.length}`}
        </Text>
        {provider.supportsSystemDefault ? (
          <Button
            size="xs"
            variant="outline"
            disabled={usingSystem || busyKey !== null}
            onPress={() => onSelect(sysKey, provider.agent, 'system')}
          >
            {busyKey === sysKey ? 'Switching…' : 'Use system'}
          </Button>
        ) : null}
      </Row>

      {provider.accounts.map((acc) => (
        <OrcaAccountCard
          key={acc.id}
          agent={provider.agent}
          account={acc}
          busyKey={busyKey}
          confirmDeleteId={confirmDeleteId}
          isLastActive={provider.agent === 'antigravity' && acc.active && isLastActiveProvider}
          onSelect={onSelect}
          onStartDelete={onStartDelete}
          onConfirmDelete={onConfirmDelete}
          onCancelDelete={onCancelDelete}
        />
      ))}
    </Stack>
  )
}
