import { create } from 'zustand'
import { markAccountRateLimited } from '@renderer/lib/auth/provider-auth'
import type { AccountRateLimit } from '@renderer/lib/api/types'

export interface CodexQuotaWindow {
  usedPercent?: number
  windowMinutes?: number
  resetAt?: string
  resetAfterSeconds?: number
}

export interface CodexQuota {
  type: 'codex'
  planType?: string
  primary?: CodexQuotaWindow
  secondary?: CodexQuotaWindow
  primaryOverSecondaryLimitPercent?: number
  credits?: {
    hasCredits?: boolean
    balance?: number
    unlimited?: boolean
  }
  fetchedAt: number
}

export interface CopilotQuota {
  type: 'copilot'
  sku?: string
  chatEnabled?: boolean
  telemetry?: string
  apiBaseUrl?: string
  tokenExpiresAt?: number
  fetchedAt: number
}

export type ProviderQuota = CodexQuota | CopilotQuota

export interface QuotaUpdatePayload {
  requestId?: string
  url?: string
  providerId?: string
  providerBuiltinId?: string
  quota: ProviderQuota
}

interface QuotaStore {
  quotaByKey: Record<string, ProviderQuota>
  updateQuota: (key: string, quota: ProviderQuota) => void
  clearQuota: (key: string) => void
}

export const useQuotaStore = create<QuotaStore>((set) => ({
  quotaByKey: {},
  updateQuota: (key, quota) =>
    set((state) => ({ quotaByKey: { ...state.quotaByKey, [key]: quota } })),
  clearQuota: (key) =>
    set((state) => {
      const next = { ...state.quotaByKey }
      delete next[key]
      return { quotaByKey: next }
    })
}))

function resolveQuotaKey(payload: QuotaUpdatePayload): string | null {
  return payload.providerId || payload.providerBuiltinId || payload.quota?.type || null
}

let listenerRegistered = false

interface AccountRateLimitedPayload {
  providerId?: string
  providerBuiltinId?: string
  accountId?: string
  resetAt: number
  reason: 'http-429' | 'codex-quota'
  windowType?: 'primary' | 'secondary'
  message?: string
}

if (typeof window !== 'undefined' && window.electron?.ipcRenderer && !listenerRegistered) {
  listenerRegistered = true
  window.electron.ipcRenderer.on('api:quota-update', (_event, payload: QuotaUpdatePayload) => {
    if (!payload?.quota) return
    const key = resolveQuotaKey(payload)
    if (!key) return
    useQuotaStore.getState().updateQuota(key, payload.quota)
  })

  window.electron.ipcRenderer.on(
    'api:account-rate-limited',
    (_event, payload: AccountRateLimitedPayload) => {
      if (!payload || !payload.accountId) return
      const providerId = payload.providerId || payload.providerBuiltinId
      if (!providerId) return
      const info: Omit<AccountRateLimit, 'limitedAt'> = {
        resetAt: payload.resetAt,
        reason: payload.reason,
        windowType: payload.windowType,
        message: payload.message
      }
      markAccountRateLimited(providerId, payload.accountId, info)
    }
  )
}
