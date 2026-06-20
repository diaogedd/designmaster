import { getDb } from './database'

export interface TaskRow {
  id: string
  session_id: string
  plan_id: string | null
  subject: string
  description: string
  active_form: string | null
  status: string
  owner: string | null
  blocks: string
  blocked_by: string
  metadata: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

export function listTasksBySession(sessionId: string): TaskRow[] {
  const db = getDb()
  return db
    .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY sort_order ASC')
    .all(sessionId) as TaskRow[]
}

export function getTask(id: string): TaskRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
}

export function createTask(task: {
  id: string
  sessionId: string
  planId?: string
  subject: string
  description: string
  activeForm?: string
  status?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  metadata?: Record<string, unknown>
  sortOrder: number
  createdAt: number
  updatedAt: number
}): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO tasks (id, session_id, plan_id, subject, description, active_form, status, owner, blocks, blocked_by, metadata, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id,
    task.sessionId,
    task.planId ?? null,
    task.subject,
    task.description,
    task.activeForm ?? null,
    task.status ?? 'pending',
    task.owner ?? null,
    JSON.stringify(task.blocks ?? []),
    JSON.stringify(task.blockedBy ?? []),
    task.metadata ? JSON.stringify(task.metadata) : null,
    task.sortOrder,
    task.createdAt,
    task.updatedAt
  )
}

export function updateTask(
  id: string,
  patch: Partial<{
    subject: string
    description: string
    activeForm: string | null
    status: string
    owner: string | null
    blocks: string[]
    blockedBy: string[]
    metadata: Record<string, unknown> | null
    sortOrder: number
    updatedAt: number
  }>
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.subject !== undefined) {
    sets.push('subject = ?')
    values.push(patch.subject)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    values.push(patch.description)
  }
  if (patch.activeForm !== undefined) {
    sets.push('active_form = ?')
    values.push(patch.activeForm)
  }
  if (patch.status !== undefined) {
    sets.push('status = ?')
    values.push(patch.status)
  }
  if (patch.owner !== undefined) {
    sets.push('owner = ?')
    values.push(patch.owner)
  }
  if (patch.blocks !== undefined) {
    sets.push('blocks = ?')
    values.push(JSON.stringify(patch.blocks))
  }
  if (patch.blockedBy !== undefined) {
    sets.push('blocked_by = ?')
    values.push(JSON.stringify(patch.blockedBy))
  }
  if (patch.metadata !== undefined) {
    sets.push('metadata = ?')
    values.push(patch.metadata ? JSON.stringify(patch.metadata) : null)
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?')
    values.push(patch.sortOrder)
  }
  if (patch.updatedAt !== undefined) {
    sets.push('updated_at = ?')
    values.push(patch.updatedAt)
  }

  if (sets.length === 0) return

  values.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteTask(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
}

export function deleteTasksBySession(sessionId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM tasks WHERE session_id = ?').run(sessionId)
}
