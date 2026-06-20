import { nanoid } from 'nanoid'
import path from 'node:path'
import { getDb } from './database'
import type {
  MemoryCitationEntry,
  MemoryJobKind,
  MemoryJobStatus,
  MemoryPipelineJob,
  MemoryPipelineListJobsQuery,
  MemoryPipelineListRootsQuery,
  MemoryRootDescriptor,
  MemoryRootInput,
  MemoryRootScope,
  MemoryStage1Output,
  MemoryStage1OutputInput
} from '../../shared/memory-automation-types'

interface MemoryRootRow {
  id: string
  scope: string
  project_id: string | null
  working_folder: string | null
  ssh_connection_id: string | null
  root_path: string
  transport: string
  owner_key: string
  created_at: number
  updated_at: number
}

interface MemoryJobRow {
  id: string
  kind: string
  status: string
  memory_root_id: string | null
  source_session_id: string | null
  lease_owner: string | null
  lease_expires_at: number | null
  attempts: number
  error: string | null
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
}

interface MemoryStage1OutputRow {
  id: string
  memory_root_id: string
  scope: string
  source_session_id: string
  source_updated_at: number | null
  raw_memory: string
  rollout_summary: string
  rollout_slug: string
  fingerprint: string
  status: string
  usage_count: number
  last_usage_at: number | null
  created_at: number
  updated_at: number
}

function normalizeOwnerPath(value: string, sshConnectionId?: string | null): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (sshConnectionId) return trimmed.replace(/\\/g, '/')
  return path.normalize(trimmed).replace(/\\/g, '/').toLowerCase()
}

function buildOwnerKey(input: MemoryRootInput): string {
  const transport = input.transport ?? (input.sshConnectionId ? 'ssh' : 'local')
  const projectId = input.projectId?.trim() ?? ''
  const workingFolder = normalizeOwnerPath(input.workingFolder ?? '', input.sshConnectionId)
  const rootPath = normalizeOwnerPath(input.rootPath, input.sshConnectionId)
  const sshConnectionId = input.sshConnectionId?.trim() ?? ''
  return [input.scope, transport, projectId, sshConnectionId, workingFolder, rootPath].join('::')
}

function mapRoot(row: MemoryRootRow): MemoryRootDescriptor {
  return {
    id: row.id,
    scope: row.scope as MemoryRootScope,
    projectId: row.project_id,
    workingFolder: row.working_folder,
    sshConnectionId: row.ssh_connection_id,
    rootPath: row.root_path,
    transport: row.transport as MemoryRootDescriptor['transport'],
    ownerKey: row.owner_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapJob(row: MemoryJobRow): MemoryPipelineJob {
  return {
    id: row.id,
    kind: row.kind as MemoryJobKind,
    status: row.status as MemoryJobStatus,
    memoryRootId: row.memory_root_id,
    sourceSessionId: row.source_session_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapStage1(row: MemoryStage1OutputRow): MemoryStage1Output {
  return {
    id: row.id,
    memoryRootId: row.memory_root_id,
    scope: row.scope as MemoryRootScope,
    sourceSessionId: row.source_session_id,
    sourceUpdatedAt: row.source_updated_at,
    rawMemory: row.raw_memory,
    rolloutSummary: row.rollout_summary,
    rolloutSlug: row.rollout_slug,
    fingerprint: row.fingerprint,
    status: row.status as MemoryStage1Output['status'],
    usageCount: row.usage_count,
    lastUsageAt: row.last_usage_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function ensureMemoryRoot(input: MemoryRootInput): MemoryRootDescriptor {
  const db = getDb()
  const now = Date.now()
  const ownerKey = buildOwnerKey(input)
  const existing = db
    .prepare('SELECT * FROM memory_roots WHERE owner_key = ?')
    .get(ownerKey) as MemoryRootRow | undefined

  if (existing) {
    db.prepare(
      `UPDATE memory_roots
          SET project_id = ?,
              working_folder = ?,
              ssh_connection_id = ?,
              root_path = ?,
              transport = ?,
              updated_at = ?
        WHERE id = ?`
    ).run(
      input.projectId ?? null,
      input.workingFolder ?? null,
      input.sshConnectionId ?? null,
      input.rootPath,
      input.transport ?? (input.sshConnectionId ? 'ssh' : 'local'),
      now,
      existing.id
    )
    return getMemoryRoot(existing.id)!
  }

  const id = nanoid()
  db.prepare(
    `INSERT INTO memory_roots (
       id, scope, project_id, working_folder, ssh_connection_id, root_path, transport,
       owner_key, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.scope,
    input.projectId ?? null,
    input.workingFolder ?? null,
    input.sshConnectionId ?? null,
    input.rootPath,
    input.transport ?? (input.sshConnectionId ? 'ssh' : 'local'),
    ownerKey,
    now,
    now
  )
  return getMemoryRoot(id)!
}

export function getMemoryRoot(id: string): MemoryRootDescriptor | null {
  const row = getDb()
    .prepare('SELECT * FROM memory_roots WHERE id = ?')
    .get(id) as MemoryRootRow | undefined
  return row ? mapRoot(row) : null
}

export function listMemoryRoots(query: MemoryPipelineListRootsQuery = {}): MemoryRootDescriptor[] {
  const where: string[] = []
  const params: unknown[] = []
  if (query.scope && query.scope !== 'both') {
    where.push('scope = ?')
    params.push(query.scope)
  }
  if (query.projectId !== undefined) {
    where.push('project_id IS ?')
    params.push(query.projectId)
  }
  if (query.workingFolder !== undefined) {
    where.push('working_folder IS ?')
    params.push(query.workingFolder)
  }
  if (query.sshConnectionId !== undefined) {
    where.push('ssh_connection_id IS ?')
    params.push(query.sshConnectionId)
  }
  if (query.rootPath !== undefined) {
    where.push('root_path IS ?')
    params.push(query.rootPath)
  }

  const rows = getDb()
    .prepare(
      `SELECT *
         FROM memory_roots
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY scope ASC, updated_at DESC`
    )
    .all(...params) as MemoryRootRow[]
  return rows.map(mapRoot)
}

export function createMemoryJob(input: {
  kind: MemoryJobKind
  status?: MemoryJobStatus
  memoryRootId?: string | null
  sourceSessionId?: string | null
  leaseOwner?: string | null
}): MemoryPipelineJob {
  const now = Date.now()
  const id = nanoid()
  getDb()
    .prepare(
      `INSERT INTO memory_jobs (
         id, kind, status, memory_root_id, source_session_id, lease_owner, lease_expires_at,
         attempts, error, started_at, finished_at, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.kind,
      input.status ?? 'running',
      input.memoryRootId ?? null,
      input.sourceSessionId ?? null,
      input.leaseOwner ?? null,
      input.leaseOwner ? now + 60 * 60 * 1000 : null,
      input.status === 'running' || input.status === undefined ? 1 : 0,
      null,
      input.status === 'running' || input.status === undefined ? now : null,
      null,
      now,
      now
    )
  return getMemoryJob(id)!
}

export function getMemoryJob(id: string): MemoryPipelineJob | null {
  const row = getDb()
    .prepare('SELECT * FROM memory_jobs WHERE id = ?')
    .get(id) as MemoryJobRow | undefined
  return row ? mapJob(row) : null
}

export function finishMemoryJob(args: {
  id: string
  status: MemoryJobStatus
  error?: string | null
}): MemoryPipelineJob | null {
  const now = Date.now()
  getDb()
    .prepare(
      `UPDATE memory_jobs
          SET status = ?,
              error = ?,
              lease_owner = NULL,
              lease_expires_at = NULL,
              finished_at = ?,
              updated_at = ?
        WHERE id = ?`
    )
    .run(args.status, args.error ?? null, now, now, args.id)
  return getMemoryJob(args.id)
}

export function listMemoryJobs(query: MemoryPipelineListJobsQuery = {}): MemoryPipelineJob[] {
  const where: string[] = []
  const params: unknown[] = []
  if (query.memoryRootId !== undefined) {
    where.push('memory_root_id IS ?')
    params.push(query.memoryRootId)
  }
  if (query.sourceSessionId !== undefined) {
    where.push('source_session_id IS ?')
    params.push(query.sourceSessionId)
  }
  if (query.statuses?.length) {
    where.push(`status IN (${query.statuses.map(() => '?').join(', ')})`)
    params.push(...query.statuses)
  }
  if (query.kinds?.length) {
    where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`)
    params.push(...query.kinds)
  }
  const limit =
    typeof query.limit === 'number' && Number.isFinite(query.limit)
      ? Math.max(1, Math.min(500, Math.floor(query.limit)))
      : 50
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM memory_jobs
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY updated_at DESC
        LIMIT ?`
    )
    .all(...params, limit) as MemoryJobRow[]
  return rows.map(mapJob)
}

export function addStage1Output(input: MemoryStage1OutputInput): MemoryStage1Output {
  const db = getDb()
  const now = Date.now()
  const id = nanoid()
  db.prepare(
    `INSERT INTO memory_stage1_outputs (
       id, memory_root_id, scope, source_session_id, source_updated_at, raw_memory,
       rollout_summary, rollout_slug, fingerprint, status, usage_count, last_usage_at,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
     ON CONFLICT(memory_root_id, source_session_id, fingerprint) DO UPDATE SET
       raw_memory = excluded.raw_memory,
       rollout_summary = excluded.rollout_summary,
       rollout_slug = excluded.rollout_slug,
       status = excluded.status,
       source_updated_at = excluded.source_updated_at,
       updated_at = excluded.updated_at`
  ).run(
    id,
    input.memoryRootId,
    input.scope,
    input.sourceSessionId,
    input.sourceUpdatedAt ?? null,
    input.rawMemory,
    input.rolloutSummary,
    input.rolloutSlug,
    input.fingerprint,
    input.status ?? 'active',
    now,
    now
  )
  const row = db
    .prepare(
      `SELECT *
         FROM memory_stage1_outputs
        WHERE memory_root_id = ?
          AND source_session_id = ?
          AND fingerprint = ?`
    )
    .get(input.memoryRootId, input.sourceSessionId, input.fingerprint) as
    | MemoryStage1OutputRow
    | undefined
  return mapStage1(row!)
}

export function listStage1Outputs(args: {
  memoryRootId: string
  limit?: number
}): MemoryStage1Output[] {
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(5000, Math.floor(args.limit)))
      : 500
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM memory_stage1_outputs
        WHERE memory_root_id = ?
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(args.memoryRootId, limit) as MemoryStage1OutputRow[]
  return rows.map(mapStage1)
}

export function recordCitationUsage(entry: MemoryCitationEntry): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO memory_citation_usage (
       id, memory_root_id, scope, source_session_id, path, line, citation_json, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nanoid(),
    entry.memoryRootId,
    entry.scope,
    entry.sourceSessionId ?? null,
    entry.path,
    entry.line ?? null,
    entry.citationJson ?? null,
    now
  )
  db.prepare(
    `UPDATE memory_stage1_outputs
        SET usage_count = usage_count + 1,
            last_usage_at = ?,
            updated_at = ?
      WHERE memory_root_id = ?`
  ).run(now, now, entry.memoryRootId)
}

export function clearMemoryRoot(args: {
  memoryRootId: string
  includeJobs?: boolean
}): { deletedStage1Outputs: number; deletedJobs: number } {
  const db = getDb()
  const tx = db.transaction(() => {
    const deletedStage1Outputs = db
      .prepare('DELETE FROM memory_stage1_outputs WHERE memory_root_id = ?')
      .run(args.memoryRootId).changes
    const deletedJobs = args.includeJobs
      ? db.prepare('DELETE FROM memory_jobs WHERE memory_root_id = ?').run(args.memoryRootId)
          .changes
      : 0
    return { deletedStage1Outputs, deletedJobs }
  })
  return tx()
}
