import { toolRegistry } from '../agent/tool-registry'
import {
  getProjectMemoryCandidatePaths,
  joinFsPath,
  readTextFile,
  resolveGlobalMemoryHomePath
} from '../agent/memory-files'
import { IPC } from '../ipc/channels'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolContext, ToolHandler } from './tool-types'
import type {
  MemoryPipelineListRootsResult,
  MemoryPipelineRunResult,
  MemoryRootDescriptor,
  MemoryRootInput,
  MemoryRootScope
} from '../../../../shared/memory-automation-types'

type MemoryToolScope = MemoryRootScope | 'both'

const MEMORY_READ_FILES = ['memory_summary.md', 'MEMORY.md', 'USER.md', 'raw_memories.md'] as const

function asScope(value: unknown): MemoryToolScope {
  return value === 'global' || value === 'project' || value === 'both' ? value : 'both'
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function ensureRoots(ctx: ToolContext): Promise<MemoryRootDescriptor[]> {
  const roots: MemoryRootInput[] = []
  const globalHomePath = await resolveGlobalMemoryHomePath(ctx.ipc)
  if (globalHomePath) {
    roots.push({ scope: 'global', rootPath: globalHomePath, transport: 'local' })
  }
  if (ctx.workingFolder?.trim()) {
    roots.push({
      scope: 'project',
      workingFolder: ctx.workingFolder,
      sshConnectionId: ctx.sshConnectionId ?? null,
      rootPath: getProjectMemoryCandidatePaths(ctx.workingFolder).preferredPath,
      transport: ctx.sshConnectionId ? 'ssh' : 'local'
    })
  }
  if (roots.length === 0) return []
  const result = (await ctx.ipc.invoke(IPC.MEMORY_PIPELINE_RUN, {
    action: 'ensure-roots',
    roots
  })) as MemoryPipelineRunResult
  return result.roots ?? []
}

async function getRoots(ctx: ToolContext, scope: MemoryToolScope): Promise<MemoryRootDescriptor[]> {
  const ensured = await ensureRoots(ctx)
  if (ensured.length > 0) {
    return scope === 'both' ? ensured : ensured.filter((root) => root.scope === scope)
  }

  const result = (await ctx.ipc.invoke(IPC.MEMORY_PIPELINE_LIST_ROOTS, {
    scope,
    workingFolder: ctx.workingFolder ?? undefined,
    sshConnectionId: ctx.sshConnectionId ?? undefined
  })) as MemoryPipelineListRootsResult
  return result.roots ?? []
}

function pickRoot(
  roots: MemoryRootDescriptor[],
  memoryRootId: string,
  scope: MemoryToolScope
): MemoryRootDescriptor | null {
  if (memoryRootId) return roots.find((root) => root.id === memoryRootId) ?? null
  if (scope === 'global') return roots.find((root) => root.scope === 'global') ?? null
  if (scope === 'project') return roots.find((root) => root.scope === 'project') ?? null
  return roots.find((root) => root.scope === 'project') ?? roots.find((root) => root.scope === 'global') ?? null
}

function resolveMemoryFilePath(root: MemoryRootDescriptor, file: string): string {
  const safeFile = MEMORY_READ_FILES.includes(file as (typeof MEMORY_READ_FILES)[number])
    ? file
    : 'memory_summary.md'
  return joinFsPath(root.rootPath, safeFile)
}

async function readRootFile(
  ctx: ToolContext,
  root: MemoryRootDescriptor,
  file: string
): Promise<{ path: string; content?: string; error?: string }> {
  const path = resolveMemoryFilePath(root, file)
  const read = await readTextFile(ctx.ipc, path, root.sshConnectionId)
  return { path, ...read }
}

async function recordUsage(
  ctx: ToolContext,
  root: MemoryRootDescriptor,
  path: string,
  line?: number | null
): Promise<void> {
  await ctx.ipc
    .invoke(IPC.MEMORY_RECORD_CITATION_USAGE, {
      scope: root.scope,
      memoryRootId: root.id,
      sourceSessionId: ctx.sessionId ?? null,
      path,
      line: line ?? null,
      citationJson: JSON.stringify({ tool: 'memory', path, line: line ?? null })
    })
    .catch(() => {})
}

const listHandler: ToolHandler = {
  definition: {
    name: 'MemoryList',
    description:
      'List available OpenCowork memory roots. Use before reading memory so citations can distinguish global and project memory.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'project', 'both'],
          description: 'Which memory scope to list. Defaults to both.'
        }
      },
      required: []
    }
  },
  execute: async (input, ctx) => {
    const scope = asScope(input.scope)
    const roots = await getRoots(ctx, scope)
    return encodeStructuredToolResult({
      roots: roots.map((root) => ({
        id: root.id,
        scope: root.scope,
        projectId: root.projectId,
        workingFolder: root.workingFolder,
        sshConnectionId: root.sshConnectionId,
        rootPath: root.rootPath,
        transport: root.transport,
        files: MEMORY_READ_FILES.map((file) => resolveMemoryFilePath(root, file))
      }))
    })
  },
  requiresApproval: () => false
}

const readHandler: ToolHandler = {
  definition: {
    name: 'MemoryRead',
    description:
      'Read a scoped OpenCowork memory file. The result includes scope, memoryRootId, path, and numbered lines for citation.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project', 'both'] },
        memoryRootId: { type: 'string', description: 'Specific memory root id from MemoryList' },
        file: {
          type: 'string',
          enum: [...MEMORY_READ_FILES],
          description: 'Memory file to read. Defaults to memory_summary.md.'
        }
      },
      required: []
    }
  },
  execute: async (input, ctx) => {
    const scope = asScope(input.scope)
    const memoryRootId = asString(input.memoryRootId)
    const file = asString(input.file) || 'memory_summary.md'
    const roots = await getRoots(ctx, scope)
    const root = pickRoot(roots, memoryRootId, scope)
    if (!root) return encodeToolError('No matching memory root found.')

    const read = await readRootFile(ctx, root, file)
    if (read.error) return encodeToolError(`Memory read failed: ${read.error}`)
    await recordUsage(ctx, root, read.path, null)
    const lines = (read.content ?? '').split(/\r?\n/)
    return encodeStructuredToolResult({
      scope: root.scope,
      memoryRootId: root.id,
      projectId: root.projectId,
      path: read.path,
      lines: lines.map((text, index) => ({ line: index + 1, text }))
    })
  },
  requiresApproval: () => false
}

const searchHandler: ToolHandler = {
  definition: {
    name: 'MemorySearch',
    description:
      'Search scoped OpenCowork memory files. Results include scope, memoryRootId, path, line, and text for citation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to search for' },
        scope: { type: 'string', enum: ['global', 'project', 'both'] },
        limit: { type: 'number', description: 'Maximum matches to return, default 20' }
      },
      required: ['query']
    }
  },
  execute: async (input, ctx) => {
    const query = asString(input.query)
    if (!query) return encodeToolError('MemorySearch requires a query.')
    const scope = asScope(input.scope)
    const limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(100, Math.floor(input.limit)))
        : 20
    const roots = await getRoots(ctx, scope)
    const matches: Array<{
      scope: MemoryRootScope
      memoryRootId: string
      projectId?: string | null
      path: string
      line: number
      text: string
    }> = []
    const normalizedQuery = query.toLowerCase()

    for (const root of roots) {
      for (const file of MEMORY_READ_FILES) {
        const read = await readRootFile(ctx, root, file)
        if (read.error || !read.content) continue
        const lines = read.content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLowerCase().includes(normalizedQuery)) continue
          matches.push({
            scope: root.scope,
            memoryRootId: root.id,
            projectId: root.projectId,
            path: read.path,
            line: index + 1,
            text: lines[index]
          })
          await recordUsage(ctx, root, read.path, index + 1)
          if (matches.length >= limit) {
            return encodeStructuredToolResult({ query, matches })
          }
        }
      }
    }

    return encodeStructuredToolResult({ query, matches })
  },
  requiresApproval: () => false
}

export function registerMemoryTools(): void {
  toolRegistry.register(listHandler)
  toolRegistry.register(readHandler)
  toolRegistry.register(searchHandler)
}
