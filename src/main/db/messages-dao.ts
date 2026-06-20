import { getDb } from './database'

export interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  usage: string | null
  sort_order: number
}

export interface MessageInput {
  id: string
  sessionId: string
  role: string
  content: string
  meta?: string | null
  createdAt: number
  usage?: string | null
  sortOrder: number
}

interface MessageOrderRow {
  id: string
  role: string
  created_at: number
  sort_order: number
}

const ROLE_ORDER: Record<string, number> = {
  user: 0,
  assistant: 1,
  system: 2
}

function hasSortOrderAnomaly(rows: MessageOrderRow[]): boolean {
  if (rows.length === 0) return false

  const seen = new Set<number>()
  for (let index = 0; index < rows.length; index += 1) {
    const sortOrder = rows[index].sort_order
    if (sortOrder !== index || seen.has(sortOrder)) return true
    seen.add(sortOrder)
  }

  return false
}

function normalizeSessionMessageSortOrders(sessionId: string): void {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, role, created_at, sort_order
         FROM messages
        WHERE session_id = ?
        ORDER BY sort_order ASC, created_at ASC`
    )
    .all(sessionId) as MessageOrderRow[]

  if (!hasSortOrderAnomaly(rows)) return

  const ordered = [...rows].sort((left, right) => {
    const createdAtDelta = left.created_at - right.created_at
    if (createdAtDelta !== 0) return createdAtDelta

    const roleDelta = (ROLE_ORDER[left.role] ?? 10) - (ROLE_ORDER[right.role] ?? 10)
    if (roleDelta !== 0) return roleDelta

    return left.sort_order - right.sort_order
  })

  const update = db.prepare('UPDATE messages SET sort_order = ? WHERE id = ?')
  const tx = db.transaction(() => {
    ordered.forEach((row, index) => {
      if (row.sort_order !== index) {
        update.run(index, row.id)
      }
    })
  })
  tx()
}

export function getMessages(sessionId: string): MessageRow[] {
  const db = getDb()
  normalizeSessionMessageSortOrders(sessionId)
  return db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(sessionId) as MessageRow[]
}

export function getUserMessages(sessionId: string): MessageRow[] {
  const db = getDb()
  normalizeSessionMessageSortOrders(sessionId)
  return db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? AND role = ? ORDER BY sort_order ASC, created_at ASC'
    )
    .all(sessionId, 'user') as MessageRow[]
}

export function getMessagesPage(sessionId: string, limit: number, offset: number): MessageRow[] {
  const db = getDb()
  normalizeSessionMessageSortOrders(sessionId)
  return db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?'
    )
    .all(sessionId, limit, offset) as MessageRow[]
}

export function addMessage(msg: MessageInput): void {
  const db = getDb()
  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.meta ?? null,
        msg.createdAt,
        msg.usage ?? null,
        msg.sortOrder
      )

    if (result.changes > 0) {
      db.prepare(
        'UPDATE sessions SET message_count = COALESCE(message_count, 0) + 1 WHERE id = ?'
      ).run(msg.sessionId)
    }
  })
  tx()
}

export function addMessages(msgs: MessageInput[]): void {
  if (msgs.length === 0) return
  const db = getDb()
  const tx = db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const newCountBySession = new Map<string, number>()
    for (const msg of msgs) {
      const result = insert.run(
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.meta ?? null,
        msg.createdAt,
        msg.usage ?? null,
        msg.sortOrder
      )
      if (result.changes > 0) {
        newCountBySession.set(msg.sessionId, (newCountBySession.get(msg.sessionId) ?? 0) + 1)
      }
    }
    for (const [sessionId, count] of newCountBySession) {
      db.prepare(
        'UPDATE sessions SET message_count = COALESCE(message_count, 0) + ? WHERE id = ?'
      ).run(count, sessionId)
    }
  })
  tx()
}

export function upsertMessage(msg: MessageInput): void {
  const db = getDb()
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT session_id FROM messages WHERE id = ?').get(msg.id) as
      | { session_id: string }
      | undefined

    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         role = excluded.role,
         content = excluded.content,
         meta = excluded.meta,
         usage = excluded.usage`
    ).run(
      msg.id,
      msg.sessionId,
      msg.role,
      msg.content,
      msg.meta ?? null,
      msg.createdAt,
      msg.usage ?? null,
      msg.sortOrder
    )

    if (!existing) {
      db.prepare(
        'UPDATE sessions SET message_count = COALESCE(message_count, 0) + 1 WHERE id = ?'
      ).run(msg.sessionId)
    }
  })
  tx()
}

export function updateMessage(
  msgId: string,
  patch: Partial<{ content: string; meta: string | null; usage: string | null }>
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.content !== undefined) {
    sets.push('content = ?')
    values.push(patch.content)
  }
  if (patch.meta !== undefined) {
    sets.push('meta = ?')
    values.push(patch.meta)
  }
  if (patch.usage !== undefined) {
    sets.push('usage = ?')
    values.push(patch.usage)
  }

  if (sets.length === 0) return

  values.push(msgId)
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function clearMessages(sessionId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
  db.prepare('UPDATE sessions SET message_count = 0 WHERE id = ?').run(sessionId)
}

export function deleteMessage(sessionId: string, messageId: string): boolean {
  const db = getDb()
  const result = db
    .prepare('DELETE FROM messages WHERE session_id = ? AND id = ?')
    .run(sessionId, messageId)
  if (result.changes <= 0) return false

  db.prepare(
    'UPDATE sessions SET message_count = MAX(COALESCE(message_count, 0) - 1, 0) WHERE id = ?'
  ).run(sessionId)
  return true
}

export function replaceMessages(
  sessionId: string,
  messages: Array<{
    id: string
    role: string
    content: string
    meta?: string | null
    createdAt: number
    usage?: string | null
    sortOrder: number
  }>
): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
    const insert = db.prepare(
      `INSERT OR REPLACE INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const msg of messages) {
      insert.run(
        msg.id,
        sessionId,
        msg.role,
        msg.content,
        msg.meta ?? null,
        msg.createdAt,
        msg.usage ?? null,
        msg.sortOrder
      )
    }
    db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(messages.length, sessionId)
  })
  tx()
}

export function truncateMessagesFrom(sessionId: string, fromSortOrder: number): void {
  const db = getDb()
  const removed = db
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND sort_order >= ?')
    .get(sessionId, fromSortOrder) as { cnt: number }

  db.prepare('DELETE FROM messages WHERE session_id = ? AND sort_order >= ?').run(
    sessionId,
    fromSortOrder
  )

  if (removed.cnt > 0) {
    db.prepare(
      'UPDATE sessions SET message_count = MAX(COALESCE(message_count, 0) - ?, 0) WHERE id = ?'
    ).run(removed.cnt, sessionId)
  }
}

export function deleteLastMessage(sessionId: string, role: string): MessageRow | null {
  const db = getDb()
  const last = db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? AND role = ? ORDER BY sort_order DESC LIMIT 1'
    )
    .get(sessionId, role) as MessageRow | undefined
  if (!last) return null
  db.prepare('DELETE FROM messages WHERE id = ?').run(last.id)
  db.prepare(
    'UPDATE sessions SET message_count = MAX(COALESCE(message_count, 0) - 1, 0) WHERE id = ?'
  ).run(sessionId)
  return last
}

export function getMessageCount(sessionId: string): number {
  const db = getDb()
  const row = db
    .prepare('SELECT message_count as cnt FROM sessions WHERE id = ?')
    .get(sessionId) as { cnt?: number } | undefined
  return row?.cnt ?? 0
}
