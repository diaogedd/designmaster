import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const AGENTS_DIR = path.join(os.homedir(), '.open-cowork', 'agents')

/**
 * Resolve the path to the bundled resources/agents/ directory.
 * - Dev: <project>/resources/agents/
 * - Production: <app>/resources/agents/ (asarUnpacked)
 */
function getBundledAgentsDir(): string {
  const isDev = !app.isPackaged

  if (isDev) {
    return path.join(app.getAppPath(), 'resources', 'agents')
  }

  const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'agents')
  if (fs.existsSync(unpackedDir)) {
    return unpackedDir
  }

  return path.join(process.resourcesPath, 'resources', 'agents')
}

/**
 * Copy built-in agents from resources/agents/ to ~/.open-cowork/agents/.
 * Only copies an agent if it does not already exist in the target,
 * so user modifications are preserved.
 */
function ensureBuiltinAgents(): void {
  try {
    const bundledDir = getBundledAgentsDir()
    if (!fs.existsSync(bundledDir)) {
      console.warn('[Agents] Bundled agents directory not found:', bundledDir)
      return
    }

    if (!fs.existsSync(AGENTS_DIR)) {
      fs.mkdirSync(AGENTS_DIR, { recursive: true })
    }

    const entries = fs.readdirSync(bundledDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.md')) continue

      const targetPath = path.join(AGENTS_DIR, entry.name)
      if (fs.existsSync(targetPath)) continue // already exists, skip

      fs.copyFileSync(path.join(bundledDir, entry.name), targetPath)
    }
  } catch (err) {
    console.error('[Agents] Failed to initialize builtin agents:', err)
  }
}

// --- Frontmatter parsing ---

export interface AgentInfo {
  /** Unique name (used as subType in Task tool) */
  name: string
  /** Human-readable description (shown in Task tool description) */
  description: string
  /** Lucide icon name */
  icon?: string
  /** Allowed tool names. Supports '*' to expose all registered tools. */
  tools: string[]
  /** Legacy alias kept for compatibility with existing renderer code and saved files. */
  allowedTools: string[]
  /** Tools explicitly denied for this agent. */
  disallowedTools: string[]
  /** Max LLM turns */
  maxTurns: number
  /** Legacy alias kept for compatibility with existing renderer code and saved files. */
  maxIterations: number
  /** Optional initial task prefix */
  initialPrompt?: string
  /** Whether this agent is intended for background execution */
  background?: boolean
  /** Optional model override */
  model?: string
  /** Optional temperature override */
  temperature?: number
  /** The system prompt (body after frontmatter) */
  systemPrompt: string
}

export interface AgentManageItem {
  id: string
  name: string
  description: string
  path: string
  source: 'user'
  editable: true
}

function isPathInsideDir(targetPath: string, baseDir: string): boolean {
  const relative = path.relative(baseDir, targetPath)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Parse a single agent .md file into AgentInfo.
 * Returns null if parsing fails or required fields are missing.
 */
function parseAgentFile(content: string, filename: string): AgentInfo | null {
  const fmMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return null

  const fmBlock = fmMatch[1]
  const body = content.slice(fmMatch[0].length).trimStart()

  const getRawValue = (key: string): string | undefined => {
    const m = fmBlock.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (!m) return undefined
    return m[1].trim()
  }

  const getString = (key: string): string | undefined => {
    const value = getRawValue(key)
    if (value === undefined) return undefined
    return value.replace(/^["']|["']$/g, '')
  }

  const getNumber = (key: string): number | undefined => {
    const s = getString(key)
    if (s === undefined) return undefined
    const n = Number(s)
    return isNaN(n) ? undefined : n
  }

  const getBoolean = (key: string): boolean | undefined => {
    const s = getString(key)
    if (s === undefined) return undefined
    if (s === 'true') return true
    if (s === 'false') return false
    return undefined
  }

  const getStringList = (key: string): string[] | undefined => {
    const raw = getRawValue(key)
    if (!raw) return undefined

    const normalized = raw
      .replace(/^\[(.*)\]$/, '$1')
      .split(',')
      .map((item) => item.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)

    return normalized.length > 0 ? normalized : undefined
  }

  const name = getString('name')
  const description = getString('description')
  if (!name || !description) {
    console.warn(`[Agents] Skipping ${filename}: missing name or description`)
    return null
  }

  const tools = getStringList('tools') ??
    getStringList('allowedTools') ?? ['Read', 'Glob', 'Grep', 'LS', 'Bash']
  const disallowedTools = getStringList('disallowedTools') ?? []
  const maxTurns = getNumber('maxTurns') ?? getNumber('maxIterations') ?? 0

  return {
    name,
    description,
    icon: getString('icon'),
    tools,
    allowedTools: tools,
    disallowedTools,
    maxTurns,
    maxIterations: maxTurns,
    initialPrompt: getString('initialPrompt'),
    background: getBoolean('background'),
    model: getString('model'),
    temperature: getNumber('temperature'),
    systemPrompt: body || `You are ${name}, a specialized agent.`
  }
}

function collectManageAgents(): AgentManageItem[] {
  if (!fs.existsSync(AGENTS_DIR)) return []

  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
  const agents: AgentManageItem[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) continue
    if (!entry.name.endsWith('.md')) continue

    try {
      const agentPath = path.join(AGENTS_DIR, entry.name)
      const content = fs.readFileSync(agentPath, 'utf-8')
      const agent = parseAgentFile(content, entry.name)
      if (!agent) continue

      agents.push({
        id: agentPath,
        name: agent.name,
        description: agent.description,
        path: agentPath,
        source: 'user',
        editable: true
      })
    } catch {
      // Skip unreadable files
    }
  }

  return agents.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

/**
 * Scan ~/.open-cowork/agents/ and return all available agents.
 * Each .md file with valid frontmatter is treated as an agent.
 * Shared between the `agents:list` ipcMain handler and the sidecar
 * `electron/invoke` bridge.
 */
export function listAgents(): AgentInfo[] {
  try {
    const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    const agents: AgentInfo[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) continue
      if (!entry.name.endsWith('.md')) continue
      try {
        const content = fs.readFileSync(path.join(AGENTS_DIR, entry.name), 'utf-8')
        const agent = parseAgentFile(content, entry.name)
        if (agent) agents.push(agent)
      } catch {
        // Skip unreadable files
      }
    }
    return agents
  } catch {
    return []
  }
}

export function registerAgentsHandlers(): void {
  // Initialize builtin agents on startup
  ensureBuiltinAgents()

  ipcMain.handle('agents:list', async (): Promise<AgentInfo[]> => listAgents())

  /**
   * agents:load — read and parse a specific agent .md file by name.
   */
  ipcMain.handle(
    'agents:load',
    async (_event, args: { name: string }): Promise<AgentInfo | { error: string }> => {
      try {
        if (!fs.existsSync(AGENTS_DIR)) {
          return { error: `Agents directory not found` }
        }
        // Search for the agent file by name field (not filename)
        const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) continue
          if (!entry.name.endsWith('.md')) continue
          try {
            const content = fs.readFileSync(path.join(AGENTS_DIR, entry.name), 'utf-8')
            const agent = parseAgentFile(content, entry.name)
            if (agent && agent.name === args.name) return agent
          } catch {
            // Skip unreadable files
          }
        }
        return { error: `Agent "${args.name}" not found` }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('agents:manage-list', async (): Promise<AgentManageItem[]> => {
    try {
      return collectManageAgents()
    } catch {
      return []
    }
  })

  ipcMain.handle(
    'agents:manage-read',
    async (
      _event,
      args: { path: string }
    ): Promise<
      | {
          id: string
          name: string
          description: string
          path: string
          source: 'user'
          editable: true
          content: string
        }
      | { error: string }
    > => {
      try {
        const targetPath = args?.path?.trim()
        if (!targetPath) return { error: 'Agent path is required' }
        if (!isPathInsideDir(targetPath, AGENTS_DIR)) {
          return { error: 'Agent path is outside the managed directory' }
        }
        if (!fs.existsSync(targetPath)) {
          return { error: `Agent file not found: ${targetPath}` }
        }

        const content = fs.readFileSync(targetPath, 'utf-8')
        const agent = parseAgentFile(content, path.basename(targetPath))
        if (!agent) return { error: `Agent file is invalid: ${targetPath}` }

        return {
          id: targetPath,
          name: agent.name,
          description: agent.description,
          path: targetPath,
          source: 'user',
          editable: true,
          content
        }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'agents:manage-save',
    async (
      _event,
      args: { path: string; content: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const targetPath = args?.path?.trim()
        if (!targetPath) return { success: false, error: 'Agent path is required' }
        if (!isPathInsideDir(targetPath, AGENTS_DIR)) {
          return { success: false, error: 'Agent path is outside the managed directory' }
        }

        const parsed = parseAgentFile(args.content, path.basename(targetPath))
        if (!parsed) {
          return {
            success: false,
            error: 'Agent markdown is invalid or missing required frontmatter'
          }
        }

        fs.writeFileSync(targetPath, args.content, 'utf-8')
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )
}
