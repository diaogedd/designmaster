import { getDb } from './database'

export type StoredRunChangeStatus = 'open' | 'reverted'
export type StoredFileChangeStatus = 'open' | 'reverted'
export type StoredChangeTransport = 'local' | 'ssh'
export type StoredChangeOp = 'create' | 'modify'

export interface StoredFileSnapshot {
  exists: boolean
  text?: string
  fullText?: string
  previewText?: string
  tailPreviewText?: string
  textOmitted?: boolean
  hash: string | null
  size: number
  lineCount?: number
}

export interface StoredTrackedFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: StoredChangeTransport
  connectionId?: string
  op: StoredChangeOp
  status: StoredFileChangeStatus
  before: StoredFileSnapshot
  after: StoredFileSnapshot
  createdAt: number
  revertedAt?: number
}

export interface StoredRunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: StoredRunChangeStatus
  changes: StoredTrackedFileChange[]
  createdAt: number
  updatedAt: number
}

interface StoredRunChangeSetRow {
  run_id: string
  session_id: string | null
  assistant_message_id: string
  status: StoredRunChangeStatus
  created_at: number
  updated_at: number
}

interface StoredFileChangeRow {
  id: string
  run_id: string
  session_id: string | null
  tool_use_id: string | null
  tool_name: string | null
  file_path: string
  transport: StoredChangeTransport
  connection_id: string | null
  op: StoredChangeOp
  status: StoredFileChangeStatus
  before_json: string
  after_json: string
  created_at: number
  reverted_at: number | null
  sort_order: number
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function parseSnapshot(value: string): StoredFileSnapshot {
  const parsed = JSON.parse(value) as StoredFileSnapshot
  return {
    exists: parsed.exists === true,
    text: parsed.text,
    fullText: parsed.fullText,
    previewText: parsed.previewText,
    tailPreviewText: parsed.tailPreviewText,
    textOmitted: parsed.textOmitted,
    hash: typeof parsed.hash === 'string' ? parsed.hash : null,
    size: typeof parsed.size === 'number' ? parsed.size : 0,
    lineCount: parsed.lineCount
  }
}

function serializeSnapshot(snapshot: StoredFileSnapshot): string {
  return JSON.stringify(snapshot)
}

function normalizeRowStatus(value: string): StoredFileChangeStatus {
  return value === 'reverted' ? 'reverted' : 'open'
}

function normalizeRunStatus(value: string): StoredRunChangeStatus {
  return value === 'reverted' ? 'reverted' : 'open'
}

function rowToChange(row: StoredFileChangeRow): StoredTrackedFileChange {
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id ?? undefined,
    toolUseId: row.tool_use_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    filePath: row.file_path,
    transport: row.transport,
    connectionId: row.connection_id ?? undefined,
    op: row.op,
    status: normalizeRowStatus(row.status),
    before: parseSnapshot(row.before_json),
    after: parseSnapshot(row.after_json),
    createdAt: row.created_at,
    revertedAt: row.reverted_at ?? undefined
  }
}

function rowsToChangeSet(
  setRow: StoredRunChangeSetRow,
  changeRows: StoredFileChangeRow[]
): StoredRunChangeSet {
  return {
    runId: setRow.run_id,
    sessionId: setRow.session_id ?? undefined,
    assistantMessageId: setRow.assistant_message_id,
    status: normalizeRunStatus(setRow.status),
    changes: changeRows.map(rowToChange),
    createdAt: setRow.created_at,
    updatedAt: setRow.updated_at
  }
}

function loadChangeSetsByRunIds(runIds: Iterable<string>): StoredRunChangeSet[] {
  const ids = Array.from(new Set(Array.from(runIds).filter(Boolean)))
  if (ids.length === 0) return []

  const db = getDb()
  const marker = placeholders(ids)
  const setRows = db
    .prepare(`SELECT * FROM agent_change_sets WHERE run_id IN (${marker})`)
    .all(...ids) as StoredRunChangeSetRow[]
  if (setRows.length === 0) return []

  const changeRows = db
    .prepare(
      `SELECT * FROM agent_file_changes
       WHERE run_id IN (${marker})
       ORDER BY run_id ASC, sort_order ASC, created_at ASC`
    )
    .all(...ids) as StoredFileChangeRow[]
  const rowsByRunId = new Map<string, StoredFileChangeRow[]>()
  for (const row of changeRows) {
    const rows = rowsByRunId.get(row.run_id) ?? []
    rows.push(row)
    rowsByRunId.set(row.run_id, rows)
  }

  return setRows
    .map((row) => rowsToChangeSet(row, rowsByRunId.get(row.run_id) ?? []))
    .sort((left, right) => left.createdAt - right.createdAt)
}

export function getStoredRunChangeSet(runId: string): StoredRunChangeSet | null {
  const [changeSet] = loadChangeSetsByRunIds([runId])
  return changeSet ?? null
}

export function listStoredRunChangeSetsBySession(sessionId: string): StoredRunChangeSet[] {
  const trimmed = sessionId.trim()
  if (!trimmed) return []

  const db = getDb()
  const rows = db
    .prepare(
      `SELECT DISTINCT s.run_id
       FROM agent_change_sets s
       LEFT JOIN agent_file_changes c ON c.run_id = s.run_id
       WHERE s.session_id = ? OR c.session_id = ?`
    )
    .all(trimmed, trimmed) as Array<{ run_id: string }>

  return loadChangeSetsByRunIds(rows.map((row) => row.run_id))
}

interface AppendFileChangeArgs {
  runId: string
  sessionId?: string
  assistantMessageId: string
  change: StoredTrackedFileChange
  now: number
}

export function appendStoredFileChange(args: AppendFileChangeArgs): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_change_sets (
        run_id,
        session_id,
        assistant_message_id,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'open', ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        session_id = COALESCE(agent_change_sets.session_id, excluded.session_id),
        assistant_message_id = excluded.assistant_message_id,
        status = 'open',
        updated_at = excluded.updated_at`
    ).run(args.runId, args.sessionId ?? null, args.assistantMessageId, args.now, args.now)

    const nextSortRow = db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS max_sort
         FROM agent_file_changes
         WHERE run_id = ?`
      )
      .get(args.runId) as { max_sort: number } | undefined
    const nextSort = (nextSortRow?.max_sort ?? -1) + 1

    db.prepare(
      `INSERT INTO agent_file_changes (
        id,
        run_id,
        session_id,
        tool_use_id,
        tool_name,
        file_path,
        transport,
        connection_id,
        op,
        status,
        before_json,
        after_json,
        created_at,
        reverted_at,
        sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.change.id,
      args.runId,
      args.change.sessionId ?? args.sessionId ?? null,
      args.change.toolUseId ?? null,
      args.change.toolName ?? null,
      args.change.filePath,
      args.change.transport,
      args.change.connectionId ?? null,
      args.change.op,
      args.change.status,
      serializeSnapshot(args.change.before),
      serializeSnapshot(args.change.after),
      args.change.createdAt,
      args.change.revertedAt ?? null,
      nextSort
    )
  })
  tx()
}

export function markFileChangeReverted(args: {
  runId: string
  changeId: string
  revertedAt: number
}): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE agent_file_changes
       SET status = 'reverted', reverted_at = ?
       WHERE run_id = ? AND id = ?`
    ).run(args.revertedAt, args.runId, args.changeId)
    recomputeRunStatusInternal(args.runId, args.revertedAt)
  })
  tx()
}

function recomputeRunStatusInternal(runId: string, now: number): void {
  const db = getDb()
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         COUNT(*) AS total
       FROM agent_file_changes
       WHERE run_id = ?`
    )
    .get(runId) as { open_count: number | null; total: number } | undefined

  const total = counts?.total ?? 0
  const openCount = counts?.open_count ?? 0
  const status: StoredRunChangeStatus = total > 0 && openCount === 0 ? 'reverted' : 'open'

  db.prepare(
    `UPDATE agent_change_sets
     SET status = ?, updated_at = ?
     WHERE run_id = ?`
  ).run(status, now, runId)
}

export function recomputeRunStatus(runId: string): void {
  recomputeRunStatusInternal(runId, Date.now())
}

export function deleteStoredFinalizedRunChangeSetsOlderThan(cutoff: number): void {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT run_id
       FROM agent_change_sets
       WHERE updated_at < ? AND status = 'reverted'`
    )
    .all(cutoff) as Array<{ run_id: string }>
  if (rows.length === 0) return

  const runIds = rows.map((row) => row.run_id)
  const marker = placeholders(runIds)
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM agent_file_changes WHERE run_id IN (${marker})`).run(...runIds)
    db.prepare(`DELETE FROM agent_change_sets WHERE run_id IN (${marker})`).run(...runIds)
  })
  tx()
}
