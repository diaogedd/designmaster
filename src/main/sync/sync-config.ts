import { randomUUID } from 'crypto'
import { readConfig, writeConfig } from '../ipc/secure-key-store'
import type { SyncConfig, SyncProviderConfig, WebDavSyncConfig } from '../../shared/sync-types'

const CONFIG_KEY = 'sync'
const DEFAULT_PROVIDER_ID = 'webdav'

export const DEFAULT_WEBDAV_CONFIG: WebDavSyncConfig = {
  displayName: 'WebDAV',
  serverUrl: '',
  username: '',
  password: '',
  remoteDir: 'opencowork-sync/v1',
  autoSyncEnabled: false,
  syncIntervalMinutes: 30,
  backupRetention: 10
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function normalizeWebDavConfig(value: unknown): WebDavSyncConfig {
  const raw = toRecord(value)
  return {
    displayName: asString(raw.displayName, DEFAULT_WEBDAV_CONFIG.displayName),
    serverUrl: asString(raw.serverUrl, DEFAULT_WEBDAV_CONFIG.serverUrl),
    username: asString(raw.username, DEFAULT_WEBDAV_CONFIG.username),
    password: asString(raw.password, DEFAULT_WEBDAV_CONFIG.password),
    remoteDir: asString(raw.remoteDir, DEFAULT_WEBDAV_CONFIG.remoteDir),
    autoSyncEnabled: asBoolean(raw.autoSyncEnabled, DEFAULT_WEBDAV_CONFIG.autoSyncEnabled),
    syncIntervalMinutes: asPositiveInt(
      raw.syncIntervalMinutes,
      DEFAULT_WEBDAV_CONFIG.syncIntervalMinutes,
      5,
      24 * 60
    ),
    backupRetention: asPositiveInt(
      raw.backupRetention,
      DEFAULT_WEBDAV_CONFIG.backupRetention,
      0,
      50
    )
  }
}

function normalizeProvider(value: unknown): SyncProviderConfig {
  const raw = toRecord(value)
  const type = raw.type === 'webdav' ? raw.type : 'webdav'
  return {
    id: asString(raw.id, DEFAULT_PROVIDER_ID) || DEFAULT_PROVIDER_ID,
    type,
    enabled: asBoolean(raw.enabled, true),
    webdav: normalizeWebDavConfig(raw.webdav)
  }
}

function createDefaultConfig(deviceId: string = randomUUID()): SyncConfig {
  return {
    deviceId,
    activeProviderId: DEFAULT_PROVIDER_ID,
    providers: [
      {
        id: DEFAULT_PROVIDER_ID,
        type: 'webdav',
        enabled: true,
        webdav: { ...DEFAULT_WEBDAV_CONFIG }
      }
    ],
    lastRun: null
  }
}

export function readSyncConfig(): SyncConfig {
  const root = readConfig()
  const raw = toRecord(root[CONFIG_KEY])
  const deviceId = asString(raw.deviceId) || randomUUID()
  const providersRaw = Array.isArray(raw.providers) ? raw.providers : []
  const providers =
    providersRaw.length > 0
      ? providersRaw.map(normalizeProvider)
      : createDefaultConfig(deviceId).providers
  const activeProviderId =
    asString(raw.activeProviderId) ||
    providers.find((provider) => provider.enabled)?.id ||
    providers[0]?.id ||
    DEFAULT_PROVIDER_ID

  return {
    deviceId,
    activeProviderId,
    providers,
    lastRun:
      raw.lastRun && typeof raw.lastRun === 'object' ? (raw.lastRun as SyncConfig['lastRun']) : null
  }
}

export function writeSyncConfig(config: SyncConfig): SyncConfig {
  const root = readConfig()
  const nextConfig: SyncConfig = {
    ...config,
    deviceId: config.deviceId || randomUUID(),
    providers:
      config.providers.length > 0
        ? config.providers.map(normalizeProvider)
        : createDefaultConfig().providers
  }
  writeConfig({
    ...root,
    [CONFIG_KEY]: nextConfig
  })
  return nextConfig
}

export function patchSyncConfig(patch: Partial<SyncConfig>): SyncConfig {
  return writeSyncConfig({
    ...readSyncConfig(),
    ...patch
  })
}

export function getActiveSyncProvider(): SyncProviderConfig {
  const config = readSyncConfig()
  return (
    config.providers.find((provider) => provider.id === config.activeProviderId) ??
    config.providers[0] ??
    createDefaultConfig(config.deviceId).providers[0]
  )
}
