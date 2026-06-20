import { app, ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const USER_COMMANDS_DIR = path.join(os.homedir(), '.open-cowork', 'commands')

export interface CommandInfo {
  name: string
  summary: string
}

export interface CommandManageItem {
  id: string
  name: string
  summary: string
  path: string
  source: 'bundled' | 'user'
  editable: boolean
  effective: boolean
}

function isPathInsideDir(targetPath: string, baseDir: string): boolean {
  const relative = path.relative(baseDir, targetPath)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function getBundledCommandsDir(): string {
  const isDev = !app.isPackaged
  if (isDev) {
    return path.join(app.getAppPath(), 'resources', 'commands')
  }

  const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'commands')
  if (fs.existsSync(unpackedDir)) {
    return unpackedDir
  }

  return path.join(process.resourcesPath, 'resources', 'commands')
}

function ensureUserCommandsDir(): void {
  if (!fs.existsSync(USER_COMMANDS_DIR)) {
    fs.mkdirSync(USER_COMMANDS_DIR, { recursive: true })
  }
}

function listCommandEntries(dir: string): fs.Dirent[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
}

function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase()
}

function commandNameFromFilename(filename: string): string {
  return filename.replace(/\.md$/i, '')
}

function summarizeCommand(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const firstMeaningfulLine = lines.find((line) => !line.startsWith('```'))
  if (!firstMeaningfulLine) return ''

  const normalized = firstMeaningfulLine.replace(/^#+\s*/, '').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized
}

function resolveBundledCommandPath(name: string): string | null {
  const normalized = normalizeCommandName(name)
  if (!normalized) return null

  const bundledDir = getBundledCommandsDir()
  const matched = listCommandEntries(bundledDir).find(
    (entry) => normalizeCommandName(commandNameFromFilename(entry.name)) === normalized
  )

  if (!matched) return null
  return path.join(bundledDir, matched.name)
}

function resolveUserCommandPath(name: string): string | null {
  const normalized = normalizeCommandName(name)
  if (!normalized) return null

  const matched = listCommandEntries(USER_COMMANDS_DIR).find(
    (entry) => normalizeCommandName(commandNameFromFilename(entry.name)) === normalized
  )

  if (!matched) return null
  return path.join(USER_COMMANDS_DIR, matched.name)
}

function resolveCommandPath(name: string): string | null {
  return resolveBundledCommandPath(name) ?? resolveUserCommandPath(name)
}

function validateCommandName(name: string): string | null {
  if (!name.trim()) return 'Command name is required'
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.trim())) {
    return 'Command name must be kebab-case (lowercase letters, numbers, hyphens)'
  }
  return null
}

function validateCommandContent(content: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return 'Command content cannot be empty'
  if (/^---\s*\n/.test(normalized)) {
    return 'Commands must be plain Markdown without YAML frontmatter'
  }
  if (/<\/?system-command\b/i.test(normalized)) {
    return 'Commands cannot contain <system-command> tags'
  }

  const lines = normalized
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const firstMeaningfulLine = lines.find((line) => !line.startsWith('```'))
  if (!firstMeaningfulLine) {
    return 'Command markdown must include at least one non-code text line'
  }

  return null
}

function buildUserCommandPath(name: string): string {
  return path.join(USER_COMMANDS_DIR, `${name}.md`)
}

function buildNewCommandTemplate(name: string): string {
  return `Describe what /${name} should make the agent do.\n\n- Goal:\n- Constraints:\n- Output format:`
}

function collectManageCommands(): CommandManageItem[] {
  const bundledDir = getBundledCommandsDir()
  const userDir = USER_COMMANDS_DIR
  const items: CommandManageItem[] = []
  const effectiveNames = new Set<string>()

  const sources: Array<{ dir: string; source: 'bundled' | 'user'; editable: boolean }> = [
    { dir: bundledDir, source: 'bundled', editable: false },
    { dir: userDir, source: 'user', editable: true }
  ]

  for (const source of sources) {
    for (const entry of listCommandEntries(source.dir)) {
      const commandPath = path.join(source.dir, entry.name)
      const name = commandNameFromFilename(entry.name)
      const normalizedName = normalizeCommandName(name)
      const content = fs.readFileSync(commandPath, 'utf-8')
      const effective = !effectiveNames.has(normalizedName)
      if (effective) {
        effectiveNames.add(normalizedName)
      }

      items.push({
        id: `${source.source}:${commandPath}`,
        name,
        summary: summarizeCommand(content),
        path: commandPath,
        source: source.source,
        editable: source.editable,
        effective
      })
    }
  }

  return items.sort((left, right) => {
    const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    if (byName !== 0) return byName
    if (left.source === right.source) return 0
    return left.source === 'bundled' ? -1 : 1
  })
}

function collectCommands(): CommandInfo[] {
  const commandsByName = new Map<string, CommandInfo>()
  const commandPaths = [
    ...listCommandEntries(getBundledCommandsDir()).map((entry) =>
      path.join(getBundledCommandsDir(), entry.name)
    ),
    ...listCommandEntries(USER_COMMANDS_DIR).map((entry) =>
      path.join(USER_COMMANDS_DIR, entry.name)
    )
  ]

  for (const commandPath of commandPaths) {
    const name = commandNameFromFilename(path.basename(commandPath))
    const normalizedName = normalizeCommandName(name)
    if (commandsByName.has(normalizedName)) continue

    const content = fs.readFileSync(commandPath, 'utf-8')
    commandsByName.set(normalizedName, {
      name,
      summary: summarizeCommand(content)
    })
  }

  return [...commandsByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

export function registerCommandsHandlers(): void {
  ensureUserCommandsDir()

  ipcMain.handle('commands:list', async (): Promise<CommandInfo[]> => {
    try {
      return collectCommands()
    } catch {
      return []
    }
  })

  ipcMain.handle(
    'commands:load',
    async (
      _event,
      args: { name: string }
    ): Promise<
      { name: string; content: string; summary: string } | { error: string; notFound?: boolean }
    > => {
      try {
        const name = args?.name?.trim()
        if (!name) return { error: 'Command name is required' }

        const commandPath = resolveCommandPath(name)
        if (!commandPath) return { error: `Command "${name}" not found`, notFound: true }

        const content = fs.readFileSync(commandPath, 'utf-8').trim()
        if (!content) return { error: `Command "${name}" is empty` }

        return {
          name: commandNameFromFilename(path.basename(commandPath)),
          content,
          summary: summarizeCommand(content)
        }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('commands:manage-list', async (): Promise<CommandManageItem[]> => {
    try {
      return collectManageCommands()
    } catch {
      return []
    }
  })

  ipcMain.handle(
    'commands:manage-read',
    async (
      _event,
      args: { path: string }
    ): Promise<
      | {
          id: string
          name: string
          summary: string
          path: string
          source: 'bundled' | 'user'
          editable: boolean
          effective: boolean
          content: string
        }
      | { error: string }
    > => {
      try {
        const targetPath = args?.path?.trim()
        if (!targetPath) return { error: 'Command path is required' }

        const isBundled = isPathInsideDir(targetPath, getBundledCommandsDir())
        const isUser = isPathInsideDir(targetPath, USER_COMMANDS_DIR)
        if (!isBundled && !isUser) {
          return { error: 'Command path is outside the managed directories' }
        }
        if (!fs.existsSync(targetPath)) {
          return { error: `Command file not found: ${targetPath}` }
        }

        const content = fs.readFileSync(targetPath, 'utf-8')
        const name = commandNameFromFilename(path.basename(targetPath))
        const source = isBundled ? 'bundled' : 'user'
        const effective = resolveCommandPath(name) === targetPath

        return {
          id: `${source}:${targetPath}`,
          name,
          summary: summarizeCommand(content),
          path: targetPath,
          source,
          editable: source === 'user',
          effective,
          content
        }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'commands:manage-create',
    async (
      _event,
      args: { name: string; content?: string }
    ): Promise<{ success: boolean; path?: string; error?: string }> => {
      try {
        const name = args?.name?.trim()
        if (!name) return { success: false, error: 'Command name is required' }

        const nameError = validateCommandName(name)
        if (nameError) return { success: false, error: nameError }

        ensureUserCommandsDir()
        const targetPath = buildUserCommandPath(name)
        if (fs.existsSync(targetPath)) {
          return { success: false, error: `Command "${name}" already exists` }
        }

        const content = args?.content?.trim() || buildNewCommandTemplate(name)
        const contentError = validateCommandContent(content)
        if (contentError) return { success: false, error: contentError }

        fs.writeFileSync(targetPath, content, 'utf-8')
        return { success: true, path: targetPath }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'commands:manage-save',
    async (
      _event,
      args: { path: string; content: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const targetPath = args?.path?.trim()
        if (!targetPath) return { success: false, error: 'Command path is required' }
        if (!isPathInsideDir(targetPath, USER_COMMANDS_DIR)) {
          return { success: false, error: 'Only user commands can be edited' }
        }

        const contentError = validateCommandContent(args.content)
        if (contentError) {
          return { success: false, error: contentError }
        }

        fs.writeFileSync(targetPath, args.content, 'utf-8')
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )
}
