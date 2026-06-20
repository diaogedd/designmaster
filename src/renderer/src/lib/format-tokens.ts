import { encode } from 'gpt-tokenizer'
import type { TokenUsage, AIModelConfig, ProviderType } from './api/types'

/**
 * Format a token count into a compact, human-readable string.
 * Examples: 0 → "0", 850 → "850", 1200 → "1.2k", 12500 → "12.5k", 1234567 → "1.23M"
 */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1_000
    return k < 10 ? `${k.toFixed(1)}k` : `${k.toFixed(0)}k`
  }
  const m = n / 1_000_000
  return m < 10 ? `${m.toFixed(2)}M` : `${m.toFixed(1)}M`
}

/**
 * Format token count with K/M units and always 2 decimal places (for animations)
 * Examples: 850 → "850", 1234 → "1.23K", 12500 → "12.50K", 1234567 → "1.23M"
 */
export function formatTokensDecimal(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k.toFixed(2)}K`
  }
  const m = n / 1_000_000
  return `${m.toFixed(2)}M`
}

export function getBillableInputTokens(
  usage: TokenUsage,
  requestType?: ProviderType | AIModelConfig['type']
): number {
  if (usage.billableInputTokens != null) return usage.billableInputTokens
  if (requestType === 'openai-responses') {
    return Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0))
  }
  return usage.inputTokens ?? 0
}

export function getCacheHitRate(billableInputTokens: number, cacheReadTokens: number): number {
  const safeBillableInputTokens = Number.isFinite(billableInputTokens)
    ? Math.max(0, billableInputTokens)
    : 0
  const safeCacheReadTokens = Number.isFinite(cacheReadTokens) ? Math.max(0, cacheReadTokens) : 0
  const totalInputTokens = safeBillableInputTokens + safeCacheReadTokens

  if (totalInputTokens <= 0) return 0
  return safeCacheReadTokens / totalInputTokens
}

export function getBillableTotalTokens(
  usage: TokenUsage,
  requestType?: ProviderType | AIModelConfig['type']
): number {
  return getBillableInputTokens(usage, requestType) + (usage.outputTokens ?? 0)
}

export function resolveCacheCreationCost(
  usage: TokenUsage,
  model: AIModelConfig | null | undefined
): { price: number | null; cost: number | null } {
  const totalCacheCreationTokens =
    usage.cacheCreationTokens ??
    (usage.cacheCreation5mTokens ?? 0) + (usage.cacheCreation1hTokens ?? 0)

  if (totalCacheCreationTokens <= 0) {
    return {
      price:
        model?.cacheCreationPrice ?? (model?.inputPrice != null ? model.inputPrice * 1.25 : null),
      cost: 0
    }
  }

  const hasDetailedBreakdown =
    usage.cacheCreation5mTokens != null || usage.cacheCreation1hTokens != null
  const cacheCreation1hTokens = usage.cacheCreation1hTokens ?? 0
  const detailedCacheCreationTokens = (usage.cacheCreation5mTokens ?? 0) + cacheCreation1hTokens
  const cacheCreation5mTokens = hasDetailedBreakdown
    ? (usage.cacheCreation5mTokens ?? 0) +
      Math.max(totalCacheCreationTokens - detailedCacheCreationTokens, 0)
    : totalCacheCreationTokens
  const cacheCreation5mPrice =
    model?.cacheCreationPrice ?? (model?.inputPrice != null ? model.inputPrice * 1.25 : null)
  const cacheCreation1hPrice = model?.inputPrice != null ? model.inputPrice * 2 : null

  if (cacheCreation5mPrice == null || (cacheCreation1hTokens > 0 && cacheCreation1hPrice == null)) {
    return { price: null, cost: null }
  }

  const cost =
    (cacheCreation5mTokens * cacheCreation5mPrice +
      cacheCreation1hTokens * (cacheCreation1hPrice ?? 0)) /
    1_000_000

  return {
    price: cost > 0 ? (cost * 1_000_000) / totalCacheCreationTokens : cacheCreation5mPrice,
    cost
  }
}

/**
 * Calculate the USD cost of a request based on token usage and model pricing.
 * Prices in AIModelConfig are per **million** tokens.
 * Returns null if pricing info is unavailable.
 */
export function calculateCost(
  usage: TokenUsage,
  model: AIModelConfig | null | undefined
): number | null {
  if (!model || model.inputPrice == null || model.outputPrice == null) return null

  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheCreationTokens =
    usage.cacheCreationTokens ??
    (usage.cacheCreation5mTokens ?? 0) + (usage.cacheCreation1hTokens ?? 0)
  const billableInput = getBillableInputTokens(usage, model.type)
  const cacheReadPrice = model.cacheHitPrice ?? model.inputPrice * 0.1
  const { cost: cacheCreationCost } = resolveCacheCreationCost(usage, model)
  if (cacheCreationTokens > 0 && cacheCreationCost == null) return null

  const inputCost = (billableInput * model.inputPrice + cacheRead * cacheReadPrice) / 1_000_000
  const outputCost = ((usage.outputTokens ?? 0) * model.outputPrice) / 1_000_000
  return inputCost + outputCost + (cacheCreationCost ?? 0)
}

/**
 * Format a USD cost value into a display string.
 * Examples: 0.001 → "<$0.01", 0.05 → "$0.05", 1.234 → "$1.23"
 */
export function formatCost(cost: number): string {
  if (cost < 0.001) return '<$0.001'
  if (cost < 0.01) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

/**
 * Estimate the number of tokens in a string using OpenAI's tokenizer (cl100k_base).
 * Use this only when the LLM does not provide token usage — prefer API-reported counts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return encode(text, { allowedSpecial: 'all' }).length
}
