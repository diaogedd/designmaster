import { getDb } from './database'

const EFFECTIVE_INPUT_TOKENS_EXPR = `COALESCE(
  billable_input_tokens,
  CASE
    WHEN request_type = 'openai-responses' THEN MAX(input_tokens - COALESCE(cache_read_tokens, 0), 0)
    ELSE input_tokens
  END
)`
const USAGE_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const USAGE_EVENTS_CLEANUP_BATCH_SIZE = 250
const USAGE_EVENTS_CLEANUP_BATCH_DELAY_MS = 50

let cleanupInFlight: Promise<UsageEventsCleanupResult> | null = null

export interface UsageEventRow {
  id: string
  created_at: number
  request_started_at: number | null
  request_finished_at: number | null
  session_id: string | null
  message_id: string | null
  project_id: string | null
  source_kind: string
  provider_id: string | null
  provider_name: string | null
  provider_type: string | null
  provider_builtin_id: string | null
  provider_base_url: string | null
  model_id: string | null
  model_name: string | null
  model_category: string | null
  request_type: string | null
  input_tokens: number
  billable_input_tokens: number | null
  output_tokens: number
  cache_creation_tokens: number | null
  cache_read_tokens: number | null
  reasoning_tokens: number | null
  context_tokens: number | null
  input_price: number | null
  output_price: number | null
  cache_creation_price: number | null
  cache_hit_price: number | null
  input_cost_usd: number | null
  output_cost_usd: number | null
  cache_creation_cost_usd: number | null
  cache_hit_cost_usd: number | null
  total_cost_usd: number | null
  ttft_ms: number | null
  total_ms: number | null
  tps: number | null
  provider_response_id: string | null
  request_debug_json: string | null
  usage_raw_json: string | null
  meta_json: string | null
}

export interface UsageEventsQuery {
  from: number
  to: number
  providerId?: string | null
  modelId?: string | null
  sourceKind?: string | null
  limit?: number
  offset?: number
}

export interface UsageActivityQuery {
  from: number
  to: number
  limit?: number
  offset?: number
}

export type UsageTimelineBucket = 'hour' | 'day'

export interface UsageEventsCleanupResult {
  cutoff: number
  deleted: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatActivityDay(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function getActivityDayRange(query: UsageActivityQuery): { fromDay: string; toDay: string } {
  return {
    fromDay: formatActivityDay(query.from),
    toDay: formatActivityDay(query.to)
  }
}

function getEffectiveInputTokens(
  event: Pick<
    UsageEventRow,
    'billable_input_tokens' | 'request_type' | 'input_tokens' | 'cache_read_tokens'
  >
): number {
  if (
    typeof event.billable_input_tokens === 'number' &&
    Number.isFinite(event.billable_input_tokens)
  ) {
    return Math.max(0, event.billable_input_tokens)
  }

  const inputTokens = toNumber(event.input_tokens)
  const cacheReadTokens = toNumber(event.cache_read_tokens)
  return event.request_type === 'openai-responses'
    ? Math.max(0, inputTokens - cacheReadTokens)
    : Math.max(0, inputTokens)
}

function addUsageActivityAggregate(db: ReturnType<typeof getDb>, event: UsageEventRow): void {
  const day = formatActivityDay(event.created_at)
  const updatedAt = Date.now()
  const inputTokens = getEffectiveInputTokens(event)
  const outputTokens = toNumber(event.output_tokens)
  const cacheCreationTokens = toNumber(event.cache_creation_tokens)
  const cacheReadTokens = toNumber(event.cache_read_tokens)
  const reasoningTokens = toNumber(event.reasoning_tokens)
  const totalCostUsd = toNumber(event.total_cost_usd)
  const providerId = event.provider_id ?? ''
  const modelId = event.model_id ?? ''

  db.prepare(
    `INSERT INTO usage_activity_daily (
      day, first_at, last_at, request_count, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, reasoning_tokens, total_cost_usd, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      first_at = MIN(first_at, excluded.first_at),
      last_at = MAX(last_at, excluded.last_at),
      request_count = request_count + excluded.request_count,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
      total_cost_usd = total_cost_usd + excluded.total_cost_usd,
      updated_at = excluded.updated_at`
  ).run(
    day,
    event.created_at,
    event.created_at,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    reasoningTokens,
    totalCostUsd,
    updatedAt
  )

  db.prepare(
    `INSERT INTO usage_activity_daily_models (
      day, provider_id, provider_name, model_id, model_name, request_count,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      reasoning_tokens, total_cost_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, provider_id, model_id) DO UPDATE SET
      provider_name = COALESCE(excluded.provider_name, provider_name),
      model_name = COALESCE(excluded.model_name, model_name),
      request_count = request_count + excluded.request_count,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
      total_cost_usd = total_cost_usd + excluded.total_cost_usd,
      updated_at = excluded.updated_at`
  ).run(
    day,
    providerId,
    event.provider_name,
    modelId,
    event.model_name,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    reasoningTokens,
    totalCostUsd,
    updatedAt
  )

  db.prepare(
    `INSERT INTO usage_activity_daily_providers (
      day, provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url,
      request_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      reasoning_tokens, total_cost_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, provider_id) DO UPDATE SET
      provider_name = COALESCE(excluded.provider_name, provider_name),
      provider_type = COALESCE(excluded.provider_type, provider_type),
      provider_builtin_id = COALESCE(excluded.provider_builtin_id, provider_builtin_id),
      provider_base_url = COALESCE(excluded.provider_base_url, provider_base_url),
      request_count = request_count + excluded.request_count,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
      total_cost_usd = total_cost_usd + excluded.total_cost_usd,
      updated_at = excluded.updated_at`
  ).run(
    day,
    providerId,
    event.provider_name,
    event.provider_type,
    event.provider_builtin_id,
    event.provider_base_url,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    reasoningTokens,
    totalCostUsd,
    updatedAt
  )
}

export function addUsageEvent(
  event: Omit<UsageEventRow, 'created_at'> & { created_at?: number }
): void {
  const db = getDb()
  const normalizedEvent = {
    ...event,
    created_at: event.created_at ?? Date.now()
  } as UsageEventRow

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO usage_events (
        id, created_at, request_started_at, request_finished_at, session_id, message_id, project_id,
        source_kind, provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url,
        model_id, model_name, model_category, request_type,
        input_tokens, billable_input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        reasoning_tokens, context_tokens,
        input_price, output_price, cache_creation_price, cache_hit_price,
        input_cost_usd, output_cost_usd, cache_creation_cost_usd, cache_hit_cost_usd, total_cost_usd,
        ttft_ms, total_ms, tps, provider_response_id, request_debug_json, usage_raw_json, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      normalizedEvent.id,
      normalizedEvent.created_at,
      normalizedEvent.request_started_at,
      normalizedEvent.request_finished_at,
      normalizedEvent.session_id,
      normalizedEvent.message_id,
      normalizedEvent.project_id,
      normalizedEvent.source_kind,
      normalizedEvent.provider_id,
      normalizedEvent.provider_name,
      normalizedEvent.provider_type,
      normalizedEvent.provider_builtin_id,
      normalizedEvent.provider_base_url,
      normalizedEvent.model_id,
      normalizedEvent.model_name,
      normalizedEvent.model_category,
      normalizedEvent.request_type,
      normalizedEvent.input_tokens,
      normalizedEvent.billable_input_tokens,
      normalizedEvent.output_tokens,
      normalizedEvent.cache_creation_tokens,
      normalizedEvent.cache_read_tokens,
      normalizedEvent.reasoning_tokens,
      normalizedEvent.context_tokens,
      normalizedEvent.input_price,
      normalizedEvent.output_price,
      normalizedEvent.cache_creation_price,
      normalizedEvent.cache_hit_price,
      normalizedEvent.input_cost_usd,
      normalizedEvent.output_cost_usd,
      normalizedEvent.cache_creation_cost_usd,
      normalizedEvent.cache_hit_cost_usd,
      normalizedEvent.total_cost_usd,
      normalizedEvent.ttft_ms,
      normalizedEvent.total_ms,
      normalizedEvent.tps,
      normalizedEvent.provider_response_id,
      normalizedEvent.request_debug_json,
      normalizedEvent.usage_raw_json,
      normalizedEvent.meta_json
    )
    addUsageActivityAggregate(db, normalizedEvent)
  })

  insert()
}

function buildWhere(query: UsageEventsQuery): { clause: string; params: unknown[] } {
  const where: string[] = ['created_at >= ?', 'created_at <= ?']
  const params: unknown[] = [query.from, query.to]
  if (query.providerId) {
    where.push('provider_id = ?')
    params.push(query.providerId)
  }
  if (query.modelId) {
    where.push('model_id = ?')
    params.push(query.modelId)
  }
  if (query.sourceKind) {
    where.push('source_kind = ?')
    params.push(query.sourceKind)
  }
  return { clause: `WHERE ${where.join(' AND ')}`, params }
}

export function getUsageOverview(query: UsageEventsQuery): Record<string, unknown> {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  return (
    (db
      .prepare(
        `SELECT
          COUNT(*) AS request_count,
          COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
          COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS billable_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
          AVG(ttft_ms) AS avg_ttft_ms,
          AVG(total_ms) AS avg_total_ms
        FROM usage_events
        ${clause}`
      )
      .get(...params) as Record<string, unknown>) ?? {}
  )
}

export function getUsageDaily(query: UsageEventsQuery): Record<string, unknown>[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  return db
    .prepare(
      `SELECT
        strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS request_count,
        COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        AVG(ttft_ms) AS avg_ttft_ms,
        AVG(total_ms) AS avg_total_ms
      FROM usage_events
      ${clause}
      GROUP BY day
      ORDER BY day DESC`
    )
    .all(...params) as Record<string, unknown>[]
}

export function getUsageTimeline(
  query: UsageEventsQuery,
  bucket: UsageTimelineBucket
): Record<string, unknown>[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  const bucketLabelExpr =
    bucket === 'hour'
      ? "strftime('%Y-%m-%d %H:00', created_at / 1000, 'unixepoch', 'localtime')"
      : "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')"

  return db
    .prepare(
      `SELECT
        ${bucketLabelExpr} AS bucket_label,
        COUNT(*) AS request_count,
        COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
      FROM usage_events
      ${clause}
      GROUP BY bucket_label
      ORDER BY bucket_label DESC`
    )
    .all(...params) as Record<string, unknown>[]
}

export function getUsageByModel(query: UsageEventsQuery): Record<string, unknown>[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  return db
    .prepare(
      `SELECT
        model_id,
        model_name,
        provider_id,
        provider_name,
        COUNT(*) AS request_count,
        COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        AVG(ttft_ms) AS avg_ttft_ms,
        AVG(total_ms) AS avg_total_ms
      FROM usage_events
      ${clause}
      GROUP BY model_id, model_name, provider_id, provider_name
      ORDER BY total_cost_usd DESC, request_count DESC`
    )
    .all(...params) as Record<string, unknown>[]
}

export function getUsageByProvider(query: UsageEventsQuery): Record<string, unknown>[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  return db
    .prepare(
      `SELECT
        provider_id,
        provider_name,
        provider_type,
        provider_builtin_id,
        provider_base_url,
        COUNT(*) AS request_count,
        COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        AVG(ttft_ms) AS avg_ttft_ms,
        AVG(total_ms) AS avg_total_ms
      FROM usage_events
      ${clause}
      GROUP BY provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url
      ORDER BY total_cost_usd DESC, request_count DESC`
    )
    .all(...params) as Record<string, unknown>[]
}

export function getUsageActivityOverview(query: UsageActivityQuery): Record<string, unknown> {
  const db = getDb()
  const { fromDay, toDay } = getActivityDayRange(query)
  return (
    (db
      .prepare(
        `SELECT
          COALESCE(SUM(request_count), 0) AS request_count,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(input_tokens), 0) AS billable_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
          NULL AS avg_ttft_ms,
          NULL AS avg_total_ms
        FROM usage_activity_daily
        WHERE day >= ? AND day <= ?`
      )
      .get(fromDay, toDay) as Record<string, unknown>) ?? {}
  )
}

export function getUsageActivityDaily(query: UsageActivityQuery): Record<string, unknown>[] {
  const db = getDb()
  const { fromDay, toDay } = getActivityDayRange(query)
  return db
    .prepare(
      `SELECT
        day,
        request_count,
        input_tokens,
        input_tokens AS billable_input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        reasoning_tokens,
        total_cost_usd,
        NULL AS avg_ttft_ms,
        NULL AS avg_total_ms
      FROM usage_activity_daily
      WHERE day >= ? AND day <= ?
      ORDER BY day DESC`
    )
    .all(fromDay, toDay) as Record<string, unknown>[]
}

export function getUsageActivityByModel(query: UsageActivityQuery): Record<string, unknown>[] {
  const db = getDb()
  const { fromDay, toDay } = getActivityDayRange(query)
  const limit = Math.max(1, Math.min(200, query.limit ?? 50))
  const offset = Math.max(0, query.offset ?? 0)
  return db
    .prepare(
      `SELECT
        NULLIF(model_id, '') AS model_id,
        COALESCE(MAX(model_name), NULLIF(model_id, ''), '-') AS model_name,
        NULLIF(provider_id, '') AS provider_id,
        COALESCE(MAX(provider_name), NULLIF(provider_id, ''), '-') AS provider_name,
        COALESCE(SUM(request_count), 0) AS request_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
      FROM usage_activity_daily_models
      WHERE day >= ? AND day <= ?
      GROUP BY model_id, provider_id
      ORDER BY
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) +
          COALESCE(SUM(cache_creation_tokens), 0) + COALESCE(SUM(cache_read_tokens), 0) DESC,
        COALESCE(SUM(request_count), 0) DESC
      LIMIT ? OFFSET ?`
    )
    .all(fromDay, toDay, limit, offset) as Record<string, unknown>[]
}

export function getUsageActivityByProvider(query: UsageActivityQuery): Record<string, unknown>[] {
  const db = getDb()
  const { fromDay, toDay } = getActivityDayRange(query)
  const limit = Math.max(1, Math.min(200, query.limit ?? 50))
  const offset = Math.max(0, query.offset ?? 0)
  return db
    .prepare(
      `SELECT
        NULLIF(provider_id, '') AS provider_id,
        COALESCE(MAX(provider_name), NULLIF(provider_id, ''), '-') AS provider_name,
        MAX(provider_type) AS provider_type,
        MAX(provider_builtin_id) AS provider_builtin_id,
        MAX(provider_base_url) AS provider_base_url,
        COALESCE(SUM(request_count), 0) AS request_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
      FROM usage_activity_daily_providers
      WHERE day >= ? AND day <= ?
      GROUP BY provider_id
      ORDER BY
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) +
          COALESCE(SUM(cache_creation_tokens), 0) + COALESCE(SUM(cache_read_tokens), 0) DESC,
        COALESCE(SUM(request_count), 0) DESC
      LIMIT ? OFFSET ?`
    )
    .all(fromDay, toDay, limit, offset) as Record<string, unknown>[]
}

export function deleteUsageEvents(query: UsageEventsQuery): { deleted: number } {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  const info = db.prepare(`DELETE FROM usage_events ${clause}`).run(...params)
  return { deleted: Number(info.changes ?? 0) }
}

async function cleanupExpiredUsageEventsInternal(): Promise<UsageEventsCleanupResult> {
  const db = getDb()
  const cutoff = Date.now() - USAGE_EVENTS_RETENTION_MS
  let deleted = 0

  const deleteBatch = db.prepare(
    `DELETE FROM usage_events
      WHERE rowid IN (
        SELECT rowid
        FROM usage_events
        WHERE created_at < ?
        ORDER BY created_at ASC
        LIMIT ?
      )`
  )

  while (true) {
    const info = deleteBatch.run(cutoff, USAGE_EVENTS_CLEANUP_BATCH_SIZE)
    const changes = Number(info.changes ?? 0)
    if (changes <= 0) break

    deleted += changes
    if (changes < USAGE_EVENTS_CLEANUP_BATCH_SIZE) break

    await sleep(USAGE_EVENTS_CLEANUP_BATCH_DELAY_MS)
  }

  return { cutoff, deleted }
}

export function cleanupExpiredUsageEvents(): Promise<UsageEventsCleanupResult> {
  if (!cleanupInFlight) {
    cleanupInFlight = cleanupExpiredUsageEventsInternal().finally(() => {
      cleanupInFlight = null
    })
  }

  return cleanupInFlight
}

export function listUsageEvents(query: UsageEventsQuery): UsageEventRow[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  const limit = Math.max(1, Math.min(200, query.limit ?? 50))
  const offset = Math.max(0, query.offset ?? 0)
  return db
    .prepare(
      `SELECT * FROM usage_events
      ${clause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as UsageEventRow[]
}
