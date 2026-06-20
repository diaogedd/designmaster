import { getDb } from './database'

export interface PlanRow {
  id: string
  session_id: string
  title: string
  status: string
  file_path: string | null
  content: string | null
  spec_json: string | null
  created_at: number
  updated_at: number
}

export function listPlans(): PlanRow[] {
  const db = getDb()
  return db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as PlanRow[]
}

export function getPlan(id: string): PlanRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined
}

export function getPlanBySession(sessionId: string): PlanRow | undefined {
  const db = getDb()
  return db
    .prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(sessionId) as PlanRow | undefined
}

export function createPlan(plan: {
  id: string
  sessionId: string
  title: string
  status?: string
  filePath?: string
  content?: string
  specJson?: string
  createdAt: number
  updatedAt: number
}): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO plans (id, session_id, title, status, file_path, content, spec_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    plan.id,
    plan.sessionId,
    plan.title,
    plan.status ?? 'drafting',
    plan.filePath ?? null,
    plan.content ?? null,
    plan.specJson ?? null,
    plan.createdAt,
    plan.updatedAt
  )
}

export function updatePlan(
  id: string,
  patch: Partial<{
    title: string
    status: string
    filePath: string | null
    content: string | null
    specJson: string | null
    updatedAt: number
  }>
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.title !== undefined) {
    sets.push('title = ?')
    values.push(patch.title)
  }
  if (patch.status !== undefined) {
    sets.push('status = ?')
    values.push(patch.status)
  }
  if (patch.filePath !== undefined) {
    sets.push('file_path = ?')
    values.push(patch.filePath)
  }
  if (patch.content !== undefined) {
    sets.push('content = ?')
    values.push(patch.content)
  }
  if (patch.specJson !== undefined) {
    sets.push('spec_json = ?')
    values.push(patch.specJson)
  }
  if (patch.updatedAt !== undefined) {
    sets.push('updated_at = ?')
    values.push(patch.updatedAt)
  }

  if (sets.length === 0) return

  values.push(id)
  db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function deletePlan(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM plans WHERE id = ?').run(id)
}
