import { ipcMain } from 'electron'
import type {
  SyncConfig,
  SyncConflictResolution,
  SyncProviderConfig,
  SyncRunMode
} from '../../shared/sync-types'
import { getActiveRunJobIds } from '../cron/cron-scheduler'
import { readSyncConfig, writeSyncConfig } from '../sync/sync-config'
import { syncEngine } from '../sync/sync-engine'
import { getSidecarManager } from './sidecar-manager'

let autoSyncTimer: ReturnType<typeof setInterval> | null = null

function normalizeRunMode(value: unknown): SyncRunMode {
  return value === 'push' || value === 'pull' || value === 'sync' ? value : 'sync'
}

function stopAutoSyncTimer(): void {
  if (!autoSyncTimer) return
  clearInterval(autoSyncTimer)
  autoSyncTimer = null
}

function shouldDeferAutoSync(): boolean {
  const status = syncEngine.getStatus()
  if (status.running || status.pendingConflicts.length > 0) return true
  if (getActiveRunJobIds().length > 0) return true
  return getSidecarManager().hasActiveRuns()
}

export function configureAutoSyncTimer(): void {
  stopAutoSyncTimer()
  const config = readSyncConfig()
  const provider = config.providers.find((item) => item.id === config.activeProviderId)
  if (!provider?.enabled || !provider.webdav.autoSyncEnabled) return

  const intervalMs = Math.max(5, provider.webdav.syncIntervalMinutes) * 60 * 1000
  autoSyncTimer = setInterval(() => {
    if (shouldDeferAutoSync()) return
    void syncEngine.run('sync')
  }, intervalMs)
}

export function registerSyncHandlers(): void {
  ipcMain.handle('sync:config:get', () => readSyncConfig())

  ipcMain.handle('sync:config:set', (_event, config: SyncConfig) => {
    const next = writeSyncConfig(config)
    configureAutoSyncTimer()
    return next
  })

  ipcMain.handle('sync:providers:list', () => syncEngine.getProviderDescriptors())

  ipcMain.handle('sync:connection:test', (_event, provider?: SyncProviderConfig) => {
    return syncEngine.testConnection(provider)
  })

  ipcMain.handle('sync:status', () => syncEngine.getStatus())

  ipcMain.handle('sync:run', (_event, args?: { mode?: unknown }) => {
    return syncEngine.run(normalizeRunMode(args?.mode))
  })

  ipcMain.handle(
    'sync:conflicts:resolve',
    (_event, args?: { resolutions?: SyncConflictResolution[] }) => {
      return syncEngine.resolveConflicts(Array.isArray(args?.resolutions) ? args.resolutions : [])
    }
  )

  configureAutoSyncTimer()
}
