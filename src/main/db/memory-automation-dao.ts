import { nanoid } from 'nanoid'
import { getDb } from './database'
import type {
  MemoryAutomationEntry,
  MemoryAutomationFilterReason,
  MemoryAutomationListQuery,
  MemoryAutomationRecordInput,
  MemoryAutomationStatus,
  MemoryAutomationTarget
} from '../../shared/memory-automation-types'

interface MemoryAutomationEntryRow {
  id: string
  scope: string
  root_scope: string | null
  memory_root_id: string | null
  job_id: string | null
  project_id: string | null
  target: string
  kind: string
  content: string
  confidence: number
  source_session_id: string | null
  target_path: string | null
  status: string
  filter_reason: string | null
  fingerprint: string
  evidence_json: string | null
  written_at: number | null
  error: string | null
  before_content: string | null
  after_content: string | null
  appended_text: string | null
  ssh_connection_id: string | null
  created_at: number
  updated_at: number
  undone_at: number | null
}

function mapRow(row: MemoryAutomationEntryRow): MemoryAutomationEntry {
  return {
    id: row.id,
    scope: row.scope as MemoryAutomationEntry['scope'],
    rootScope: row.root_scope as MemoryAutomationEntry['rootScope'],
    memoryRootId: row.memory_root_id,
    jobId: row.job_id,
    projectId: row.project_id,
    target: row.target as MemoryAutomationEntry['target'],
    kind: row.kind as MemoryAutomationEntry['kind'],
    content: row.content,
    confidence: row.confidence,
    sourceSessionId: row.source_session_id,
    targetPath: row.target_path,
    status: row.status as MemoryAutomationStatus,
    filterReason: row.filter_reason as MemoryAutomationFilterReason | null,
    fingerprint: row.fingerprint,
    evidenceJson: row.evidence_json,
    writtenAt: row.written_at,
    error: row.error,
    beforeContent: row.before_content,
    afterContent: row.after_content,
    appendedText: row.appended_text,
    sshConnectionId: row.ssh_connection_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    undoneAt: row.undone_at
  }
}

function serializeEvidence(input: MemoryAutomationRecordInput): string | null {
  if (typeof input.evidenceJson === 'string') return input.evidenceJson
  if (input.evidence === undefined || input.evidence === null) return null
  try {
    return JSON.stringify(input.evidence)
  } catch {
    return null
  }
}

export function addMemoryAutomationEntry(
  input: MemoryAutomationRecordInput
): MemoryAutomationEntry {
  const db = getDb()
  const now = Date.now()
  const id = nanoid()
  const confidence =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : 0

  db.prepare(
     `INSERT INTO memory_automation_entries (
       id,
       scope,
       root_scope,
       memory_root_id,
       job_id,
       project_id,
       target,
       kind,
       content,
       confidence,
       source_session_id,
       target_path,
       status,
       filter_reason,
       fingerprint,
       evidence_json,
       written_at,
       error,
       before_content,
       after_content,
       appended_text,
       ssh_connection_id,
       created_at,
       updated_at,
       undone_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.scope,
    input.rootScope ?? null,
    input.memoryRootId ?? null,
    input.jobId ?? null,
    input.projectId ?? null,
    input.target,
    input.kind,
    input.content,
    confidence,
    input.sourceSessionId ?? null,
    input.targetPath ?? null,
    input.status,
    input.filterReason ?? null,
    input.fingerprint,
    serializeEvidence(input),
    input.writtenAt ?? null,
    input.error ?? null,
    input.beforeContent ?? null,
    input.afterContent ?? null,
    input.appendedText ?? null,
    input.sshConnectionId ?? null,
    now,
    now,
    null
  )

  return getMemoryAutomationEntry(id)!
}

export function getMemoryAutomationEntry(id: string): MemoryAutomationEntry | null {
  const row = getDb()
    .prepare(
      `SELECT *
         FROM memory_automation_entries
        WHERE id = ?`
    )
    .get(id) as MemoryAutomationEntryRow | undefined
  return row ? mapRow(row) : null
}

export function listMemoryAutomationEntries(
  query: MemoryAutomationListQuery = {}
): MemoryAutomationEntry[] {
  const where: string[] = []
  const params: unknown[] = []

  if (query.statuses?.length) {
    where.push(`status IN (${query.statuses.map(() => '?').join(', ')})`)
    params.push(...query.statuses)
  }

  if (query.id) {
    where.push('id = ?')
    params.push(query.id)
  }

  if (query.memoryRootId !== undefined) {
    where.push('memory_root_id IS ?')
    params.push(query.memoryRootId)
  }

  if (query.rootScope !== undefined) {
    where.push('root_scope IS ?')
    params.push(query.rootScope)
  }

  if (query.projectId !== undefined) {
    where.push('project_id IS ?')
    params.push(query.projectId)
  }

  if (query.targets?.length) {
    where.push(`target IN (${query.targets.map(() => '?').join(', ')})`)
    params.push(...query.targets)
  }

  if (query.sourceSessionId !== undefined) {
    where.push('source_session_id IS ?')
    params.push(query.sourceSessionId)
  }

  if (query.targetPath) {
    where.push('target_path = ?')
    params.push(query.targetPath)
  }

  if (query.targetPathIncludes) {
    where.push('target_path LIKE ?')
    params.push(`%${query.targetPathIncludes}%`)
  }

  if (query.fingerprint) {
    where.push('fingerprint = ?')
    params.push(query.fingerprint)
  }

  const limit =
    typeof query.limit === 'number' && Number.isFinite(query.limit)
      ? Math.max(1, Math.min(500, Math.floor(query.limit)))
      : 50
  const offset =
    typeof query.offset === 'number' && Number.isFinite(query.offset)
      ? Math.max(0, Math.floor(query.offset))
      : 0

  const selectSnapshots = query.includeContentSnapshots
    ? 'before_content, after_content, appended_text,'
    : 'NULL AS before_content, NULL AS after_content, NULL AS appended_text,'

  const rows = getDb()
    .prepare(
      `SELECT
         id,
         scope,
         root_scope,
         memory_root_id,
         job_id,
         project_id,
         target,
         kind,
         content,
         confidence,
         source_session_id,
         target_path,
         status,
         filter_reason,
         fingerprint,
         evidence_json,
         written_at,
         error,
         ${selectSnapshots}
         ssh_connection_id,
         created_at,
         updated_at,
         undone_at
       FROM memory_automation_entries
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as MemoryAutomationEntryRow[]

  return rows.map(mapRow)
}

export function markMemoryAutomationUndo(
  id: string,
  status: 'undone' | 'error' = 'undone',
  error?: string | null
): MemoryAutomationEntry | null {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `UPDATE memory_automation_entries
        SET status = ?,
            error = ?,
            updated_at = ?,
            undone_at = CASE WHEN ? = 'undone' THEN ? ELSE undone_at END
      WHERE id = ?`
  ).run(status, error ?? null, now, status, now, id)
  return getMemoryAutomationEntry(id)
}

export function hasProcessedRollup(args: {
  scope: string
  targetPath: string
  sourceDate: string
  contentHash: string
}): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
         FROM memory_automation_rollups
        WHERE scope = ?
          AND target_path = ?
          AND source_date = ?
          AND content_hash = ?
        LIMIT 1`
    )
    .get(args.scope, args.targetPath, args.sourceDate, args.contentHash)
  return Boolean(row)
}

export function markProcessedRollup(args: {
  scope: string
  target: MemoryAutomationTarget
  targetPath: string
  sourceDate: string
  contentHash: string
}): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO memory_automation_rollups (
         scope,
         target,
         target_path,
         source_date,
         content_hash,
         processed_at
       )
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(args.scope, args.target, args.targetPath, args.sourceDate, args.contentHash, now)
}
