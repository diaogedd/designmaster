import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { nanoid } from 'nanoid'
import { getDb } from './database'
import { readSettings } from '../ipc/settings-handlers'

export interface ProjectRow {
  id: string
  name: string
  working_folder: string | null
  ssh_connection_id: string | null
  plugin_id: string | null
  pinned: number
  created_at: number
  updated_at: number
}

function sanitizeProjectName(rawName: string): string {
  const cleaned = rawName
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'New Project'
}

function getPreferredLocalProjectBaseDirectory(): string {
  const settings = readSettings()
  const mode = settings.projectDefaultDirectoryMode
  const customDir =
    typeof settings.projectDefaultDirectory === 'string'
      ? settings.projectDefaultDirectory.trim()
      : ''
  const lastUsedDir =
    typeof settings.lastProjectDirectory === 'string' ? settings.lastProjectDirectory.trim() : ''

  if (mode === 'custom' && customDir) {
    return customDir
  }
  if (lastUsedDir) {
    return lastUsedDir
  }
  return path.join(os.homedir(), 'Documents')
}

function ensureUniqueLocalProjectDirectory(baseName: string): { name: string; folderPath: string } {
  const baseDirectory = getPreferredLocalProjectBaseDirectory()
  if (!fs.existsSync(baseDirectory)) {
    fs.mkdirSync(baseDirectory, { recursive: true })
  }

  const safeBaseName = sanitizeProjectName(baseName)
  let candidateName = safeBaseName
  let suffix = 1
  let candidatePath = path.join(baseDirectory, candidateName)

  while (fs.existsSync(candidatePath)) {
    candidateName = `${safeBaseName} (${suffix})`
    candidatePath = path.join(baseDirectory, candidateName)
    suffix += 1
  }

  fs.mkdirSync(candidatePath, { recursive: true })
  return { name: candidateName, folderPath: candidatePath }
}

export function listProjects(): ProjectRow[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at, updated_at
         FROM projects
        ORDER BY pinned DESC, CASE WHEN plugin_id IS NULL THEN 0 ELSE 1 END, updated_at DESC`
    )
    .all() as ProjectRow[]
}

export function getProject(id: string): ProjectRow | undefined {
  const db = getDb()
  return db
    .prepare(
      `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at, updated_at
         FROM projects
        WHERE id = ?`
    )
    .get(id) as ProjectRow | undefined
}

export function findProjectByPluginId(pluginId: string): ProjectRow | undefined {
  const db = getDb()
  return db
    .prepare(
      `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at, updated_at
         FROM projects
        WHERE plugin_id = ?
        ORDER BY pinned DESC, updated_at DESC
        LIMIT 1`
    )
    .get(pluginId) as ProjectRow | undefined
}

export function createProject(project: {
  id?: string
  name: string
  workingFolder?: string | null
  sshConnectionId?: string | null
  pluginId?: string | null
  pinned?: boolean
  createdAt?: number
  updatedAt?: number
}): ProjectRow {
  const db = getDb()
  const now = Date.now()
  let name = sanitizeProjectName(project.name)
  const sshConnectionId = project.sshConnectionId ?? null
  let workingFolder = project.workingFolder ?? null

  if (!workingFolder && !sshConnectionId) {
    const allocated = ensureUniqueLocalProjectDirectory(name)
    name = allocated.name
    workingFolder = allocated.folderPath
  } else if (workingFolder && !sshConnectionId && !fs.existsSync(workingFolder)) {
    fs.mkdirSync(workingFolder, { recursive: true })
  }

  const row: ProjectRow = {
    id: project.id ?? nanoid(),
    name,
    working_folder: workingFolder,
    ssh_connection_id: sshConnectionId,
    plugin_id: project.pluginId ?? null,
    pinned: project.pinned ? 1 : 0,
    created_at: project.createdAt ?? now,
    updated_at: project.updatedAt ?? now
  }

  db.prepare(
    `INSERT INTO projects (id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.name,
    row.working_folder,
    row.ssh_connection_id,
    row.plugin_id,
    row.pinned,
    row.created_at,
    row.updated_at
  )

  return row
}

export function updateProject(
  id: string,
  patch: Partial<{
    name: string
    workingFolder: string | null
    sshConnectionId: string | null
    pluginId: string | null
    pinned: boolean
    updatedAt: number
  }>
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.name !== undefined) {
    sets.push('name = ?')
    values.push(sanitizeProjectName(patch.name))
  }

  if (patch.workingFolder !== undefined) {
    const nextFolder = patch.workingFolder
    const current = getProject(id)
    const effectiveSshConnectionId =
      patch.sshConnectionId !== undefined
        ? patch.sshConnectionId
        : (current?.ssh_connection_id ?? null)
    if (nextFolder && !effectiveSshConnectionId && !fs.existsSync(nextFolder)) {
      fs.mkdirSync(nextFolder, { recursive: true })
    }
    sets.push('working_folder = ?')
    values.push(nextFolder)
  }

  if (patch.sshConnectionId !== undefined) {
    sets.push('ssh_connection_id = ?')
    values.push(patch.sshConnectionId)
  }

  if (patch.pluginId !== undefined) {
    sets.push('plugin_id = ?')
    values.push(patch.pluginId)
  }

  if (patch.pinned !== undefined) {
    sets.push('pinned = ?')
    values.push(patch.pinned ? 1 : 0)
  }

  if (patch.updatedAt !== undefined) {
    sets.push('updated_at = ?')
    values.push(patch.updatedAt)
  }

  if (sets.length === 0) return

  values.push(id)
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteProject(id: string): { projectId: string; sessionIds: string[] } | null {
  const db = getDb()
  const project = getProject(id)
  if (!project) return null

  const rows = db.prepare(`SELECT id FROM sessions WHERE project_id = ?`).all(id) as Array<{
    id: string
  }>
  const sessionIds = rows.map((row) => row.id)

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(id)
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
  })
  tx()

  return { projectId: id, sessionIds }
}

export function ensureDefaultProject(): ProjectRow {
  const db = getDb()
  const existing = db
    .prepare(
      `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at, updated_at
         FROM projects
        WHERE plugin_id IS NULL
        ORDER BY pinned DESC, updated_at DESC
        LIMIT 1`
    )
    .get() as ProjectRow | undefined

  if (existing) {
    if (!existing.working_folder && !existing.ssh_connection_id) {
      const allocated = ensureUniqueLocalProjectDirectory(existing.name || 'New Project')
      updateProject(existing.id, {
        name: allocated.name,
        workingFolder: allocated.folderPath,
        sshConnectionId: null,
        updatedAt: Date.now()
      })
      return getProject(existing.id) ?? existing
    }
    return existing
  }

  return createProject({ name: 'New Project' })
}

export function ensurePluginProject(pluginId: string, preferredName?: string): ProjectRow {
  const existing = findProjectByPluginId(pluginId)
  if (existing) return existing

  return createProject({
    name: preferredName || `Plugin ${pluginId}`,
    pluginId
  })
}
