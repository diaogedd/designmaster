import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftRight,
  Braces,
  ChevronDown,
  Download,
  Fingerprint,
  FolderArchive,
  FolderOpen,
  FolderSync,
  HardDriveDownload,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { cn } from '@renderer/lib/utils'
import {
  useSshStore,
  type SshConnection,
  type SshGroup,
  type SshSession,
  type SshWorkspaceSection
} from '@renderer/stores/ssh-store'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { SshConnectionInspector } from './SshConnectionInspector'
import { SshGroupDialog } from './SshGroupDialog'
import { SshImportDialog } from './SshImportDialog'
import { SshKeychainWorkspace } from './SshKeychainWorkspace'
import { SshSftpWorkspace } from './SshSftpWorkspace'
import {
  SshKnownHostsWorkspace,
  SshLogsWorkspace,
  SshPortForwardingWorkspace,
  SshSnippetsWorkspace
} from './SshSupportWorkspaces'

interface SshConnectionListProps {
  onConnect: (connectionId: string) => void
}

type WorkspaceNavKey = Exclude<SshWorkspaceSection, 'terminal'>

type QuickConnectTarget = {
  username: string
  host: string
  port: number
  name: string
  command: string
}

const TEST_STATUS_TTL_MS = 15000

const NAV_ITEMS: Array<{
  key: WorkspaceNavKey
  icon: LucideIcon
}> = [
  { key: 'hosts', icon: Server },
  { key: 'sftp', icon: FolderOpen },
  { key: 'keychain', icon: KeyRound },
  { key: 'forwarding', icon: ArrowLeftRight },
  { key: 'snippets', icon: Braces },
  { key: 'knownHosts', icon: Fingerprint },
  { key: 'logs', icon: ScrollText }
]

function parseQuickConnect(rawValue: string): QuickConnectTarget | null {
  const value = rawValue.trim()
  if (!value) return null

  const command = value.replace(/\s+/g, ' ')
  const startsWithSsh = command.startsWith('ssh ')
  const tokens = startsWithSsh ? command.split(' ').slice(1) : command.split(' ')
  let port = 22
  let loginToken: string | null = null

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue

    if (token === '-p') {
      const nextPort = Number.parseInt(tokens[index + 1] ?? '', 10)
      if (Number.isFinite(nextPort) && nextPort > 0) port = nextPort
      index += 1
      continue
    }

    if (token.startsWith('-p') && token.length > 2) {
      const inlinePort = Number.parseInt(token.slice(2), 10)
      if (Number.isFinite(inlinePort) && inlinePort > 0) port = inlinePort
      continue
    }

    if (token === '-l') {
      index += 1
      continue
    }

    if (token.startsWith('-')) continue
    loginToken = token
  }

  if (!loginToken && !startsWithSsh) loginToken = command
  if (!loginToken || !loginToken.includes('@')) return null

  const cleanedToken = loginToken.replace(/^ssh:\/\//, '').replace(/[;,]$/, '')
  const atIndex = cleanedToken.lastIndexOf('@')
  if (atIndex <= 0 || atIndex >= cleanedToken.length - 1) return null

  const username = cleanedToken.slice(0, atIndex)
  let host = cleanedToken.slice(atIndex + 1)
  const hostWithPort = host.match(/^([^:\s]+):(\d+)$/)
  if (hostWithPort) {
    host = hostWithPort[1]
    port = Number.parseInt(hostWithPort[2], 10) || port
  }

  if (!username || !host) return null

  return {
    username,
    host,
    port,
    name: host,
    command: `ssh ${username}@${host} -p ${port}`
  }
}

function getSessionForConnection(
  sessions: Record<string, SshSession>,
  connectionId: string
): SshSession | undefined {
  return Object.values(sessions).find(
    (item) =>
      item.connectionId === connectionId &&
      (item.status === 'connected' || item.status === 'connecting')
  )
}

function getGroupHostCount(connections: SshConnection[], groupId: string | null): number {
  return connections.filter((connection) => connection.groupId === groupId).length
}

function getStatusPillStyle(kind: 'success' | 'warning' | 'danger' | 'idle'): React.CSSProperties {
  if (kind === 'success') {
    return {
      background: 'color-mix(in srgb, var(--ssh-success) 14%, transparent)',
      color: 'var(--ssh-success)'
    }
  }

  if (kind === 'warning') {
    return {
      background: 'color-mix(in srgb, var(--ssh-warning) 16%, transparent)',
      color: 'var(--ssh-warning)'
    }
  }

  if (kind === 'danger') {
    return {
      background: 'color-mix(in srgb, var(--ssh-danger) 16%, transparent)',
      color: 'var(--ssh-danger)'
    }
  }

  return {
    background: 'color-mix(in srgb, var(--ssh-muted) 14%, transparent)',
    color: 'var(--ssh-muted)'
  }
}

function StatusPill({
  session,
  isTesting,
  testOk
}: {
  session: SshSession | undefined
  isTesting: boolean
  testOk: boolean | undefined
}): React.JSX.Element {
  const { t } = useTranslation('ssh')

  if (session?.status === 'connected') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold"
        style={getStatusPillStyle('success')}
      >
        <span className="size-1.5 rounded-full bg-current" />
        {t('list.online')}
      </span>
    )
  }

  if (session?.status === 'connecting' || isTesting) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold"
        style={getStatusPillStyle('warning')}
      >
        <Loader2 className="size-3 animate-spin" />
        {session?.status === 'connecting' ? t('connecting') : t('testing')}
      </span>
    )
  }

  if (testOk === true) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold"
        style={getStatusPillStyle('success')}
      >
        <ShieldCheck className="size-3" />
        {t('list.reachable')}
      </span>
    )
  }

  if (testOk === false) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold"
        style={getStatusPillStyle('danger')}
      >
        {t('list.unreachable')}
      </span>
    )
  }

  return (
    <span
      className="rounded-full px-2.5 py-1 text-[0.7rem] font-medium"
      style={getStatusPillStyle('idle')}
    >
      {t('list.offline')}
    </span>
  )
}

function HostRow({
  connection,
  group,
  session,
  isSelected,
  isTesting,
  testOk,
  onSelect,
  onEdit,
  onConnect,
  onTest
}: {
  connection: SshConnection
  group: SshGroup | undefined
  session: SshSession | undefined
  isSelected: boolean
  isTesting: boolean
  testOk: boolean | undefined
  onSelect: () => void
  onEdit: () => void
  onConnect: () => void
  onTest: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const tagText = group?.name ?? t('ungrouped')
  const authText = t(`migration.auth.${connection.authType}`)

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group grid w-full grid-cols-1 gap-3 border-b border-[var(--ssh-border)] px-4 py-3.5 text-left transition-all md:grid-cols-[minmax(0,1.45fr)_minmax(160px,0.85fr)_120px_230px]',
        isSelected
          ? 'bg-[var(--ssh-pill-active)] shadow-[inset_3px_0_0_var(--ssh-accent)]'
          : 'hover:bg-[var(--ssh-pill)]'
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-[13px] text-[var(--ssh-accent-contrast)] shadow-[0_12px_26px_-18px_color-mix(in_srgb,var(--ssh-accent)_60%,transparent)]"
          style={{
            background:
              'linear-gradient(135deg, var(--ssh-accent), color-mix(in srgb, var(--ssh-accent) 72%, var(--ssh-text)))'
          }}
        >
          <Server className="size-4.5" />
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[0.95rem] font-semibold text-[var(--ssh-text)]">
              {connection.name}
            </span>
            {connection.proxyJump ? (
              <span className="rounded-full bg-[var(--ssh-accent-soft)] px-2 py-0.5 text-[0.65rem] font-semibold text-[var(--ssh-accent)]">
                ProxyJump
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[0.73rem] text-[var(--ssh-muted)]">
            <span>ssh</span>
            <span className="opacity-45">/</span>
            <span className="truncate">{connection.username}</span>
            <span className="opacity-45">/</span>
            <span className="truncate">{tagText}</span>
          </div>
        </div>
      </div>

      <div className="min-w-0 md:self-center">
        <div className="truncate font-mono text-[0.78rem] text-[var(--ssh-text)] opacity-80">
          {connection.host}:{connection.port}
        </div>
        <div className="mt-1 truncate text-[0.72rem] text-[var(--ssh-muted)]">
          {authText}
          {connection.defaultDirectory ? ` / ${connection.defaultDirectory}` : ''}
        </div>
      </div>

      <div className="flex items-center md:justify-start">
        <StatusPill session={session} isTesting={isTesting} testOk={testOk} />
      </div>

      <div
        className="flex items-center gap-2 md:justify-end"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-8 rounded-[10px] px-3 text-[0.72rem] font-semibold text-[var(--ssh-muted)] hover:bg-[var(--ssh-pill)] hover:text-[var(--ssh-text)]"
          onClick={onEdit}
        >
          {t('editConnection')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 rounded-[10px] px-3 text-[0.72rem] font-semibold text-[var(--ssh-muted)] hover:bg-[var(--ssh-pill)] hover:text-[var(--ssh-text)]"
          onClick={onTest}
          disabled={isTesting}
        >
          {isTesting ? <Loader2 className="size-3.5 animate-spin" /> : t('testConnection')}
        </Button>
        <Button
          size="sm"
          className="h-8 rounded-[10px] bg-[var(--ssh-accent)] px-3 text-[0.72rem] font-bold text-[var(--ssh-accent-contrast)] hover:opacity-90"
          onClick={onConnect}
        >
          {session?.status === 'connected' ? t('openTerminal') : t('connect')}
        </Button>
      </div>
    </button>
  )
}

function GroupRail({
  groups,
  connections,
  selectedGroupId,
  onSelectGroup,
  onCreateGroup
}: {
  groups: SshGroup[]
  connections: SshConnection[]
  selectedGroupId: string | null
  onSelectGroup: (groupId: string | null) => void
  onCreateGroup: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')

  return (
    <aside className="hidden w-[220px] shrink-0 flex-col border-r border-[var(--ssh-panel-border)] bg-[var(--ssh-panel)] text-[var(--ssh-panel-text)] md:flex">
      <div className="border-b border-[var(--ssh-panel-border)] px-4 py-4">
        <div className="text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-[var(--ssh-panel-muted)] opacity-70">
          {t('workspace.vaults', { defaultValue: 'Hosts' })}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="text-[1rem] font-semibold text-[var(--ssh-panel-text)]">
            {t('workspace.groupRailTitle', { defaultValue: 'Groups' })}
          </div>
          <button
            type="button"
            onClick={onCreateGroup}
            className="inline-flex size-8 items-center justify-center rounded-[10px] bg-[var(--ssh-panel-hover)] text-[var(--ssh-panel-muted)] hover:text-[var(--ssh-panel-text)]"
            title={t('newGroup')}
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <button
          type="button"
          onClick={() => onSelectGroup(null)}
          className={cn(
            'flex w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2.5 text-left transition-colors',
            selectedGroupId === null
              ? 'bg-[var(--ssh-pill-active)] text-[var(--ssh-pill-active-text)]'
              : 'text-[var(--ssh-panel-muted)] hover:bg-[var(--ssh-panel-hover)] hover:text-[var(--ssh-panel-text)]'
          )}
        >
          <span className="min-w-0 truncate text-[0.86rem] font-medium">
            {t('workspace.allVaults', { defaultValue: 'All hosts' })}
          </span>
          <span className="text-[0.74rem] opacity-65">{connections.length}</span>
        </button>

        <div className="mt-3 space-y-1">
          {groups.map((group) => {
            const active = selectedGroupId === group.id
            return (
              <button
                key={group.id}
                type="button"
                onClick={() => onSelectGroup(group.id)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'bg-[var(--ssh-pill-active)] text-[var(--ssh-pill-active-text)]'
                    : 'text-[var(--ssh-panel-muted)] hover:bg-[var(--ssh-panel-hover)] hover:text-[var(--ssh-panel-text)]'
                )}
              >
                <span className="min-w-0 truncate text-[0.86rem] font-medium">{group.name}</span>
                <span className="text-[0.74rem] opacity-65">
                  {getGroupHostCount(connections, group.id)}
                </span>
              </button>
            )
          })}
        </div>

        <div className="mt-3 border-t border-[var(--ssh-panel-border)] pt-3">
          <button
            type="button"
            onClick={() => onSelectGroup('__ungrouped__')}
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2.5 text-left transition-colors',
              selectedGroupId === '__ungrouped__'
                ? 'bg-[var(--ssh-pill-active)] text-[var(--ssh-pill-active-text)]'
                : 'text-[var(--ssh-panel-muted)] hover:bg-[var(--ssh-panel-hover)] hover:text-[var(--ssh-panel-text)]'
            )}
          >
            <span className="min-w-0 truncate text-[0.86rem] font-medium">{t('ungrouped')}</span>
            <span className="text-[0.74rem] opacity-65">
              {getGroupHostCount(connections, null)}
            </span>
          </button>
        </div>
      </div>
    </aside>
  )
}

function HostsWorkspace({
  onConnect
}: {
  onConnect: (connectionId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const groups = useSshStore((state) => state.groups)
  const connections = useSshStore((state) => state.connections)
  const sessions = useSshStore((state) => state.sessions)
  const loadAll = useSshStore((state) => state.loadAll)
  const detailConnectionId = useSshStore((state) => state.detailConnectionId)
  const setDetailConnectionId = useSshStore((state) => state.setDetailConnectionId)
  const inspectorMode = useSshStore((state) => state.inspectorMode)
  const setInspectorMode = useSshStore((state) => state.setInspectorMode)

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [draftKey, setDraftKey] = useState(0)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<Record<string, { ok: boolean; at: number }>>({})
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<SshGroup | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [inspectorDialogOpen, setInspectorDialogOpen] = useState(false)

  const quickConnectTarget = useMemo(() => parseQuickConnect(searchQuery), [searchQuery])

  const visibleConnections = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase()
    return connections.filter((connection) => {
      if (selectedGroupId === '__ungrouped__' && connection.groupId !== null) return false
      if (
        selectedGroupId !== null &&
        selectedGroupId !== '__ungrouped__' &&
        connection.groupId !== selectedGroupId
      ) {
        return false
      }
      if (!normalized || quickConnectTarget) return true
      return (
        connection.name.toLowerCase().includes(normalized) ||
        connection.host.toLowerCase().includes(normalized) ||
        connection.username.toLowerCase().includes(normalized)
      )
    })
  }, [connections, quickConnectTarget, searchQuery, selectedGroupId])

  const selectedConnection =
    inspectorMode === 'edit' && detailConnectionId
      ? (connections.find((connection) => connection.id === detailConnectionId) ?? null)
      : null

  const selectedSession = selectedConnection
    ? getSessionForConnection(sessions, selectedConnection.id)
    : undefined

  const onlineCount = useMemo(
    () =>
      connections.filter((connection) => getSessionForConnection(sessions, connection.id)).length,
    [connections, sessions]
  )

  const activeVaultLabel =
    selectedGroupId == null
      ? t('workspace.allVaults', { defaultValue: 'All hosts' })
      : selectedGroupId === '__ungrouped__'
        ? t('ungrouped')
        : (groups.find((group) => group.id === selectedGroupId)?.name ??
          t('workspace.allVaults', { defaultValue: 'All hosts' }))

  useEffect(() => {
    if (connections.length === 0) {
      setInspectorMode('create')
      setDetailConnectionId(null)
      return
    }

    if (inspectorMode === 'create') return

    const selectedStillVisible = visibleConnections.some(
      (connection) => connection.id === detailConnectionId
    )
    if (selectedStillVisible) return

    const nextConnection = visibleConnections[0] ?? connections[0] ?? null
    setDetailConnectionId(nextConnection?.id ?? null)
  }, [
    connections,
    detailConnectionId,
    inspectorMode,
    setDetailConnectionId,
    setInspectorMode,
    visibleConnections
  ])

  const startCreateConnection = useCallback(() => {
    setInspectorMode('create')
    setDetailConnectionId(null)
    setDraftKey((current) => current + 1)
    setInspectorDialogOpen(true)
  }, [setDetailConnectionId, setInspectorMode])

  const handleSelectConnection = useCallback(
    (connectionId: string) => {
      setInspectorMode('edit')
      setDetailConnectionId(connectionId)
    },
    [setDetailConnectionId, setInspectorMode]
  )

  const handleEditConnection = useCallback(
    (connectionId: string) => {
      setInspectorMode('edit')
      setDetailConnectionId(connectionId)
      setInspectorDialogOpen(true)
    },
    [setDetailConnectionId, setInspectorMode]
  )

  const handleTest = useCallback(
    async (connectionId: string) => {
      setTestingId(connectionId)
      try {
        const result = await useSshStore.getState().testConnection(connectionId)
        setTestStatus((current) => ({
          ...current,
          [connectionId]: { ok: result.success, at: Date.now() }
        }))
        if (result.success) {
          toast.success(t('connectionSuccess'))
        } else {
          toast.error(`${t('connectionFailed')}: ${result.error}`)
        }
      } finally {
        setTestingId(null)
      }
    },
    [t]
  )

  const handleDeleteConnection = useCallback(
    async (connection: SshConnection) => {
      const ok = await confirm({
        title: t('deleteConnection'),
        description: t('confirmDelete')
      })
      if (!ok) return

      await useSshStore.getState().deleteConnection(connection.id)
      toast.success(t('deleted'))
      setInspectorDialogOpen(false)

      const remaining = useSshStore.getState().connections
      if (remaining.length === 0) {
        startCreateConnection()
        return
      }

      const nextConnection =
        visibleConnections.find((item) => item.id !== connection.id) ??
        remaining.find((item) => item.id !== connection.id) ??
        remaining[0]

      if (nextConnection) {
        setInspectorMode('edit')
        setDetailConnectionId(nextConnection.id)
      }
    },
    [setDetailConnectionId, setInspectorMode, startCreateConnection, t, visibleConnections]
  )

  const handleExportAll = useCallback(async (): Promise<void> => {
    if (connections.length === 0) {
      toast.error(t('migration.noSelection'))
      return
    }

    const ok = await confirm({
      title: t('migration.exportSensitiveTitle'),
      description: t('migration.exportSensitiveDesc')
    })
    if (!ok) return

    const date = new Date().toISOString().slice(0, 10)
    const filePick = await ipcClient.invoke(IPC.FS_SELECT_SAVE_FILE, {
      defaultPath: `open-cowork-ssh-all-${date}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (!filePick || typeof filePick !== 'object' || !('path' in filePick) || !filePick.path) {
      return
    }

    const result = (await ipcClient.invoke(IPC.SSH_EXPORT, {
      filePath: filePick.path
    })) as { success?: boolean; error?: string }

    if (result.error) {
      toast.error(result.error)
      return
    }

    toast.success(t('migration.exportSuccess'))
  }, [connections.length, t])

  const handleQuickConnect = useCallback(async (): Promise<void> => {
    if (!quickConnectTarget) return

    const existing = connections.find(
      (connection) =>
        connection.host === quickConnectTarget.host &&
        connection.username === quickConnectTarget.username &&
        connection.port === quickConnectTarget.port
    )

    if (existing) {
      setInspectorMode('edit')
      setDetailConnectionId(existing.id)
      onConnect(existing.id)
      return
    }

    try {
      const id = await useSshStore.getState().createConnection({
        name: quickConnectTarget.name,
        host: quickConnectTarget.host,
        port: quickConnectTarget.port,
        username: quickConnectTarget.username,
        authType: 'agent',
        groupId:
          selectedGroupId && selectedGroupId !== '__ungrouped__' ? selectedGroupId : undefined,
        keepAliveInterval: 60
      })
      toast.success(t('saved'))
      setInspectorMode('edit')
      setDetailConnectionId(id)
      setSearchQuery('')
      onConnect(id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [
    connections,
    onConnect,
    quickConnectTarget,
    selectedGroupId,
    setDetailConnectionId,
    setInspectorMode,
    t
  ])

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || !quickConnectTarget) return
    event.preventDefault()
    void handleQuickConnect()
  }

  return (
    <>
      <div className="flex min-w-0 flex-1 overflow-hidden bg-[var(--ssh-canvas)] text-[var(--ssh-text)]">
        <GroupRail
          groups={groups}
          connections={connections}
          selectedGroupId={selectedGroupId}
          onSelectGroup={(groupId) => setSelectedGroupId(groupId)}
          onCreateGroup={() => {
            setEditingGroup(null)
            setGroupDialogOpen(true)
          }}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-[var(--ssh-panel-border)] bg-[var(--ssh-panel)] px-4 py-3 text-[var(--ssh-panel-text)]">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[280px] flex-1">
                <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--ssh-panel-muted)] opacity-70" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t('workspace.searchHosts', {
                    defaultValue: 'Find a host or ssh user@hostname...'
                  })}
                  className="h-10 w-full rounded-[12px] border border-[var(--ssh-panel-border)] bg-[var(--ssh-panel-strong)] pl-10 pr-4 font-mono text-[0.82rem] text-[var(--ssh-panel-text)] outline-none transition placeholder:text-[var(--ssh-panel-muted)] focus:border-[var(--ssh-accent)] focus:ring-4 focus:ring-[var(--ssh-accent-soft)]"
                />
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="h-10 rounded-[12px] bg-[var(--ssh-panel-hover)] px-3 text-[0.78rem] font-semibold text-[var(--ssh-panel-text)] hover:opacity-90"
                  >
                    <Server className="size-3.5" />
                    {t('workspace.newHost', { defaultValue: 'NEW HOST' })}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={startCreateConnection}>
                    {t('newConnection')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setEditingGroup(null)
                      setGroupDialogOpen(true)
                    }}
                  >
                    {t('newGroup')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                size="sm"
                className="h-10 rounded-[12px] bg-[var(--ssh-accent)] px-4 text-[0.78rem] font-bold text-[var(--ssh-accent-contrast)] hover:opacity-90 disabled:bg-[var(--ssh-panel-hover)] disabled:text-[var(--ssh-panel-muted)]"
                onClick={() => {
                  if (quickConnectTarget) {
                    void handleQuickConnect()
                    return
                  }
                  if (selectedConnection) onConnect(selectedConnection.id)
                }}
                disabled={!selectedConnection && !quickConnectTarget}
              >
                <Zap className="size-3.5" />
                {quickConnectTarget
                  ? t('workspace.quickConnect', { defaultValue: 'Quick connect' })
                  : t('connect')}
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-[10px] bg-[var(--ssh-panel-hover)] px-3 text-[0.72rem] font-semibold text-[var(--ssh-panel-muted)] hover:text-[var(--ssh-panel-text)]"
                  >
                    <FolderArchive className="size-3.5" />
                    {activeVaultLabel}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setSelectedGroupId(null)}>
                    {t('workspace.allVaults', { defaultValue: 'All hosts' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSelectedGroupId('__ungrouped__')}>
                    {t('ungrouped')}
                  </DropdownMenuItem>
                  {groups.map((group) => (
                    <DropdownMenuItem key={group.id} onClick={() => setSelectedGroupId(group.id)}>
                      {group.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {quickConnectTarget ? (
                <div className="inline-flex min-w-0 items-center gap-2 rounded-[10px] bg-[var(--ssh-accent-soft)] px-3 py-1.5 text-[0.72rem] text-[var(--ssh-accent)]">
                  <Terminal className="size-3.5 shrink-0" />
                  <span className="truncate">{quickConnectTarget.command}</span>
                  <span className="shrink-0 opacity-65">
                    {t('workspace.quickConnectAgent', { defaultValue: 'SSH Agent' })}
                  </span>
                </div>
              ) : null}

              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex size-8 items-center justify-center rounded-[10px] bg-[var(--ssh-panel-hover)] text-[var(--ssh-panel-muted)] hover:text-[var(--ssh-panel-text)]"
                  onClick={() => void loadAll()}
                  title={t('list.refresh')}
                >
                  <RefreshCw className="size-4" />
                </button>
                <button
                  type="button"
                  className="inline-flex size-8 items-center justify-center rounded-[10px] bg-[var(--ssh-panel-hover)] text-[var(--ssh-panel-muted)] hover:text-[var(--ssh-panel-text)]"
                  onClick={() => setImportOpen(true)}
                  title={t('migration.importButton')}
                >
                  <FolderSync className="size-4" />
                </button>
                <button
                  type="button"
                  className="inline-flex size-8 items-center justify-center rounded-[10px] bg-[var(--ssh-panel-hover)] text-[var(--ssh-panel-muted)] hover:text-[var(--ssh-panel-text)]"
                  onClick={() => void handleExportAll()}
                  title={t('migration.exportAll')}
                >
                  <Download className="size-4" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <section className="flex min-w-0 flex-1 flex-col">
              <div className="border-b border-[var(--ssh-border)] px-4 py-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="text-[1.16rem] font-semibold text-[var(--ssh-text)]">
                      {t('workspace.hostsHeading', { defaultValue: 'Hosts' })}
                    </div>
                    <div className="mt-1 text-[0.76rem] text-[var(--ssh-muted)]">
                      {t('workspace.hostsMeta', {
                        defaultValue: '{{count}} hosts / {{online}} online',
                        count: visibleConnections.length,
                        online: onlineCount
                      })}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="rounded-full bg-[var(--ssh-pill)] px-3 py-1.5 text-[0.72rem] font-medium text-[var(--ssh-muted)]">
                      {activeVaultLabel}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 rounded-[10px] px-3 text-[0.72rem] font-semibold text-[var(--ssh-muted)] hover:bg-[var(--ssh-pill)] hover:text-[var(--ssh-text)]"
                      onClick={() => setImportOpen(true)}
                    >
                      <HardDriveDownload className="size-3.5" />
                      {t('migration.importButton')}
                    </Button>
                  </div>
                </div>
              </div>

              {visibleConnections.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-8">
                  <div className="max-w-[430px] text-center">
                    <div className="mx-auto flex size-16 items-center justify-center rounded-[20px] bg-[var(--ssh-accent-soft)] text-[var(--ssh-accent)]">
                      <Server className="size-7" />
                    </div>
                    <div className="mt-5 text-[1.15rem] font-semibold text-[var(--ssh-text)]">
                      {t('noConnections')}
                    </div>
                    <div className="mt-2 text-[0.86rem] leading-6 text-[var(--ssh-muted)]">
                      {searchQuery.trim()
                        ? t('workspace.noSearchMatches', {
                            defaultValue:
                              'No hosts match the current search. Try another hostname or user.'
                          })
                        : t('noConnectionsDesc')}
                    </div>
                    <Button
                      size="sm"
                      className="mt-6 h-10 rounded-[12px] bg-[var(--ssh-accent)] px-4 text-[0.82rem] font-bold text-[var(--ssh-accent-contrast)] hover:opacity-90"
                      onClick={startCreateConnection}
                    >
                      <Plus className="size-4" />
                      {t('newConnection')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="grid grid-cols-1 border-b border-[var(--ssh-border)] bg-[var(--ssh-canvas-subtle)] px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-[var(--ssh-muted)] md:grid-cols-[minmax(0,1.45fr)_minmax(160px,0.85fr)_120px_230px]">
                    <div>{t('list.host')}</div>
                    <div>{t('workspace.addressTitle', { defaultValue: 'Address' })}</div>
                    <div>{t('list.status')}</div>
                    <div className="text-right">{t('list.actions')}</div>
                  </div>

                  {visibleConnections.map((connection) => {
                    const testInfo = testStatus[connection.id]
                    const fresh =
                      typeof testInfo?.at === 'number' &&
                      Date.now() - testInfo.at < TEST_STATUS_TTL_MS
                    const testOk = fresh ? testInfo?.ok : undefined
                    const session = getSessionForConnection(sessions, connection.id)

                    return (
                      <HostRow
                        key={connection.id}
                        connection={connection}
                        group={groups.find((group) => group.id === connection.groupId)}
                        session={session}
                        isSelected={
                          inspectorMode === 'edit' && detailConnectionId === connection.id
                        }
                        isTesting={testingId === connection.id}
                        testOk={testOk}
                        onSelect={() => handleSelectConnection(connection.id)}
                        onEdit={() => handleEditConnection(connection.id)}
                        onConnect={() => onConnect(connection.id)}
                        onTest={() => void handleTest(connection.id)}
                      />
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        </main>
      </div>

      <Dialog open={inspectorDialogOpen} onOpenChange={setInspectorDialogOpen}>
        <DialogContent
          className="max-h-[min(860px,calc(100vh-2rem))] gap-0 overflow-hidden border-border bg-background p-0 text-foreground sm:max-w-[860px]"
          showCloseButton
        >
          <DialogHeader className="border-b border-border px-5 py-4 pr-12">
            <DialogTitle className="text-[1.05rem] text-foreground">
              {inspectorMode === 'create' || !selectedConnection
                ? t('newConnection')
                : t('editConnection')}
            </DialogTitle>
            <DialogDescription className="truncate text-[0.78rem] text-muted-foreground">
              {selectedConnection
                ? `${selectedConnection.username}@${selectedConnection.host}:${selectedConnection.port}`
                : t('workspace.newHostHint', {
                    defaultValue: 'Create a new SSH host profile.'
                  })}
            </DialogDescription>
          </DialogHeader>

          <div className="h-[min(720px,calc(100vh-9rem))] min-h-[520px] overflow-hidden">
            <SshConnectionInspector
              mode={connections.length === 0 ? 'create' : inspectorMode}
              draftKey={draftKey}
              connection={selectedConnection}
              groups={groups}
              session={selectedSession}
              showHeader={false}
              onConnect={(connectionId) => {
                setInspectorDialogOpen(false)
                onConnect(connectionId)
              }}
              onSaved={(connectionId) => {
                setInspectorMode('edit')
                setDetailConnectionId(connectionId)
                setInspectorDialogOpen(false)
              }}
              onDelete={(connection) => void handleDeleteConnection(connection)}
              onManageGroups={() => {
                setEditingGroup(null)
                setGroupDialogOpen(true)
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      <SshGroupDialog
        open={groupDialogOpen}
        group={editingGroup}
        onClose={() => {
          setGroupDialogOpen(false)
          setEditingGroup(null)
        }}
      />

      <SshImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          void loadAll()
        }}
      />
    </>
  )
}

export function SshConnectionList({ onConnect }: SshConnectionListProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const connections = useSshStore((state) => state.connections)
  const sessions = useSshStore((state) => state.sessions)
  const workspaceSection = useSshStore((state) => state.workspaceSection)
  const setWorkspaceSection = useSshStore((state) => state.setWorkspaceSection)

  const onlineCount = useMemo(
    () =>
      connections.filter((connection) => getSessionForConnection(sessions, connection.id)).length,
    [connections, sessions]
  )

  const body = useMemo(() => {
    switch (workspaceSection) {
      case 'keychain':
        return <SshKeychainWorkspace />
      case 'forwarding':
        return <SshPortForwardingWorkspace />
      case 'snippets':
        return <SshSnippetsWorkspace />
      case 'knownHosts':
        return <SshKnownHostsWorkspace />
      case 'logs':
        return <SshLogsWorkspace />
      case 'sftp':
        return <SshSftpWorkspace />
      case 'hosts':
      default:
        return <HostsWorkspace onConnect={onConnect} />
    }
  }, [onConnect, workspaceSection])

  return (
    <div className="flex h-full w-full min-w-0 overflow-hidden bg-[var(--ssh-canvas)] text-[var(--ssh-text)]">
      <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-[var(--ssh-panel-border)] bg-[var(--ssh-panel-strong)] py-3">
        <div className="mb-5 flex size-10 items-center justify-center rounded-[14px] bg-[var(--ssh-accent)] text-[var(--ssh-accent-contrast)] shadow-[0_12px_28px_-18px_color-mix(in_srgb,var(--ssh-accent)_70%,transparent)]">
          <Terminal className="size-5" />
        </div>

        <nav className="flex flex-1 flex-col items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const label = t(`workspace.nav.${item.key}`, {
              defaultValue:
                item.key === 'hosts'
                  ? 'Hosts'
                  : item.key === 'sftp'
                    ? 'SFTP'
                    : item.key === 'keychain'
                      ? 'Keychain'
                      : item.key === 'forwarding'
                        ? 'Port Forwarding'
                        : item.key === 'snippets'
                          ? 'Snippets'
                          : item.key === 'knownHosts'
                            ? 'Known Hosts'
                            : 'Logs'
            })
            const active = workspaceSection === item.key

            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setWorkspaceSection(item.key)}
                className={cn(
                  'relative inline-flex size-11 items-center justify-center rounded-[13px] transition-colors',
                  active
                    ? 'bg-[var(--ssh-accent)] text-[var(--ssh-accent-contrast)]'
                    : 'text-[var(--ssh-panel-muted)] hover:bg-[var(--ssh-panel-hover)] hover:text-[var(--ssh-panel-text)]'
                )}
                title={label}
              >
                <item.icon className="size-5" />
                {active ? (
                  <span className="absolute -right-[13px] top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-[var(--ssh-accent)]" />
                ) : null}
              </button>
            )
          })}
        </nav>

        <div className="mt-5 space-y-2 border-t border-[var(--ssh-panel-border)] pt-3 text-center">
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-[var(--ssh-panel-muted)] opacity-60">
            {t('dashboard.totalServers')}
          </div>
          <div className="text-[0.9rem] font-semibold text-[var(--ssh-panel-text)]">
            {connections.length}
          </div>
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-[var(--ssh-panel-muted)] opacity-60">
            {t('dashboard.onlineServers')}
          </div>
          <div className="text-[0.9rem] font-semibold text-[var(--ssh-success)]">{onlineCount}</div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 overflow-hidden">{body}</div>
    </div>
  )
}
