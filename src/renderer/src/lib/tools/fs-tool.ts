import { toolRegistry } from '../agent/tool-registry'
import { joinFsPath } from '../agent/memory-files'
import { IPC } from '../ipc/channels'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { FileReadSnapshot, ToolHandler, ToolContext } from './tool-types'

type EolStyle = '\n' | '\r\n' | null
type TextWriteToolName = 'Write' | 'Edit' | 'NotebookEdit'

type LsEntry = { name: string; type: string; path: string }
type LsLimitReason = 'max_results' | 'max_output_bytes' | null

const LS_PROMPT_MAX_ITEMS = 100
const LS_BACKEND_FETCH_LIMIT = LS_PROMPT_MAX_ITEMS + 1
const LS_PROMPT_MAX_OUTPUT_BYTES = 8 * 1024
const textEncoder = new TextEncoder()

function countOccurrences(content: string, value: string): number {
  if (!value) return 0
  return content.split(value).length - 1
}

function detectEolStyle(value: string): EolStyle {
  if (value.includes('\r\n')) return '\r\n'
  if (value.includes('\n')) return '\n'
  return null
}

function detectDominantEolStyle(value: string): EolStyle {
  let crlf = 0
  let lf = 0

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\r' && value[index + 1] === '\n') {
      crlf += 1
      index += 1
    } else if (value[index] === '\n') {
      lf += 1
    }
  }

  if (crlf === 0 && lf === 0) return null
  return crlf >= lf ? '\r\n' : '\n'
}

function normalizeToLf(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function applyEolStyle(value: string, style: EolStyle): string {
  if (!style) return value
  const normalized = normalizeToLf(value)
  return style === '\n' ? normalized : normalized.replace(/\n/g, '\r\n')
}

function buildOldStringVariants(
  oldStr: string,
  fileContent: string
): Array<{ text: string; eol: EolStyle }> {
  const variants: Array<{ text: string; eol: EolStyle }> = []
  const seen = new Set<string>()
  const addVariant = (text: string, eol: EolStyle): void => {
    if (seen.has(text)) return
    seen.add(text)
    variants.push({ text, eol })
  }

  addVariant(oldStr, detectEolStyle(oldStr))

  if (oldStr.includes('\n')) {
    const lfText = normalizeToLf(oldStr)
    addVariant(lfText, '\n')
    if (fileContent.includes('\r\n')) {
      addVariant(lfText.replace(/\n/g, '\r\n'), '\r\n')
    }
  }

  return variants
}

function getReplacementEolStyle(
  matchedOldString: { eol: EolStyle },
  fileContent: string
): EolStyle {
  return matchedOldString.eol ?? detectDominantEolStyle(fileContent)
}

function normalizeReadHistoryPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

function isFileReadSnapshot(value: unknown): value is FileReadSnapshot {
  return !!value && typeof value === 'object' && 'exists' in value
}

function isSameReadSnapshot(left: FileReadSnapshot, right: FileReadSnapshot): boolean {
  if (left.exists !== right.exists) return false
  if (!left.exists && !right.exists) return true
  return (
    (left.type ?? null) === (right.type ?? null) &&
    (left.size ?? null) === (right.size ?? null) &&
    (left.mtimeMs ?? null) === (right.mtimeMs ?? null)
  )
}

async function captureReadSnapshot(
  ctx: ToolContext,
  filePath: string
): Promise<FileReadSnapshot | { error: string }> {
  const channel = isSsh(ctx) ? IPC.SSH_FS_STAT_PATH : IPC.FS_STAT_PATH
  const args = isSsh(ctx) ? sshArgs(ctx, { path: filePath }) : { path: filePath }
  const result = await ctx.ipc.invoke(channel, args)
  if (isErrorResult(result)) return { error: result.error }
  if (!isFileReadSnapshot(result)) return { error: 'stat did not return a file snapshot' }
  return result
}

async function recordRead(ctx: ToolContext, filePath: string): Promise<void> {
  const snapshot = await captureReadSnapshot(ctx, filePath)
  if ('error' in snapshot) return
  if (!ctx.readFileHistory) ctx.readFileHistory = new Map<string, FileReadSnapshot>()
  ctx.readFileHistory.set(normalizeReadHistoryPath(filePath), snapshot)
}

async function assertCurrentFileMatchesLastRead(args: {
  ctx: ToolContext
  filePath: string
  toolName: TextWriteToolName
  allowMissingFile: boolean
}): Promise<string | null> {
  const current = await captureReadSnapshot(args.ctx, args.filePath)
  if ('error' in current) return `Could not stat file before ${args.toolName}: ${current.error}`
  if (!current.exists && args.allowMissingFile) return null

  const previous = args.ctx.readFileHistory?.get(normalizeReadHistoryPath(args.filePath))
  if (!previous) {
    return `${args.toolName} requires the file to be read in this agent turn first. Call Read on ${args.filePath} and retry.`
  }

  if (!isSameReadSnapshot(previous, current)) {
    return `${args.toolName} refused to edit because the file changed since it was last read in this turn. Call Read on ${args.filePath} again and retry.`
  }

  return null
}

// ── SSH routing helper ──

function isSsh(ctx: ToolContext): boolean {
  return !!ctx.sshConnectionId
}

function sshArgs(ctx: ToolContext, extra: Record<string, unknown>): Record<string, unknown> {
  return { connectionId: ctx.sshConnectionId, ...extra }
}

function buildChangeMeta(
  ctx: ToolContext,
  toolName: TextWriteToolName
): Record<string, unknown> | undefined {
  if (!ctx.agentRunId) return undefined
  return {
    runId: ctx.agentRunId,
    sessionId: ctx.sessionId,
    toolUseId: ctx.currentToolUseId,
    toolName
  }
}

function localWriteArgs(
  ctx: ToolContext,
  path: string,
  content: string,
  toolName: TextWriteToolName,
  beforeContent?: string
): Record<string, unknown> {
  return {
    path,
    content,
    ...(beforeContent !== undefined ? { beforeContent } : {}),
    ...(buildChangeMeta(ctx, toolName) ? { changeMeta: buildChangeMeta(ctx, toolName) } : {})
  }
}

function sshWriteArgs(
  ctx: ToolContext,
  path: string,
  content: string,
  toolName: TextWriteToolName,
  beforeContent?: string
): Record<string, unknown> {
  return sshArgs(ctx, {
    path,
    content,
    ...(beforeContent !== undefined ? { beforeContent } : {}),
    ...(buildChangeMeta(ctx, toolName) ? { changeMeta: buildChangeMeta(ctx, toolName) } : {})
  })
}

function applyExactReplacement(args: {
  content: string
  oldStr: string
  newStr: string
  replaceAll: boolean
}): { updated: string; occurrences: number } | { error: string } {
  if (!args.oldStr) {
    return { error: 'old_string must be non-empty' }
  }

  if (args.oldStr === args.newStr) {
    return { error: 'new_string must be different from old_string' }
  }

  const oldStringVariants = buildOldStringVariants(args.oldStr, args.content)
  const matchedVariant = oldStringVariants.find(
    (variant) => variant.text.length > 0 && args.content.includes(variant.text)
  )

  if (!matchedVariant) {
    return { error: `String to replace not found in file.\nString: ${args.oldStr}` }
  }

  const occurrences = countOccurrences(args.content, matchedVariant.text)
  if (!args.replaceAll && occurrences > 1) {
    return {
      error: `Found ${occurrences} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context.\nString: ${args.oldStr}`
    }
  }

  const replacementText = applyEolStyle(
    args.newStr,
    getReplacementEolStyle(matchedVariant, args.content)
  )
  const updated = args.replaceAll
    ? args.content.split(matchedVariant.text).join(replacementText)
    : args.content.replace(matchedVariant.text, replacementText)

  return { updated, occurrences }
}

// ── Plugin path permission helpers ──

function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/').replace(/\/+ /g, '/').replace(/\/$/, '')
  if (/^[a-zA-Z]:/.test(normalized)) normalized = normalized.toLowerCase()
  return normalized
}

export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/') || p.startsWith('\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(p)
}

export function resolveToolPath(inputPath: unknown, workingFolder?: string): string {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const base = workingFolder?.trim()
  if (!raw || raw === '.') {
    return base && base.length > 0 ? base : '.'
  }
  if (isAbsolutePath(raw)) return raw
  if (base && base.length > 0) return joinFsPath(base, raw)
  return raw
}

function getFileToolInputPath(input: Record<string, unknown>): string {
  const filePath = typeof input.file_path === 'string' ? input.file_path.trim() : ''
  if (filePath) return filePath
  const path = typeof input.path === 'string' ? input.path.trim() : ''
  return path
}

function estimatePromptBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length
}

function normalizeLsEntries(raw: unknown): { items: LsEntry[]; hasMore: boolean } {
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown[] }).entries)
      ? (raw as { entries: unknown[] }).entries
      : []
  const hasMore = !!(
    raw &&
    typeof raw === 'object' &&
    (raw as { hasMore?: unknown }).hasMore === true
  )

  return {
    items: source
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const name = (item as { name?: unknown }).name
        const type = (item as { type?: unknown }).type
        const path = (item as { path?: unknown }).path
        if (typeof name !== 'string' || typeof type !== 'string' || typeof path !== 'string') {
          return null
        }
        return { name, type, path }
      })
      .filter((item): item is LsEntry => !!item),
    hasMore
  }
}

function formatLsResultForPrompt(raw: unknown): LsEntry[] | Record<string, unknown> {
  if (isErrorResult(raw)) return raw

  const { items, hasMore } = normalizeLsEntries(raw)
  const limitedItems: LsEntry[] = []
  let totalBytes = 2
  let limitReason: LsLimitReason = hasMore ? 'max_results' : null

  for (const item of items) {
    if (limitedItems.length >= LS_PROMPT_MAX_ITEMS) {
      limitReason = 'max_results'
      break
    }

    const candidateBytes = estimatePromptBytes(item) + 1
    if (totalBytes + candidateBytes > LS_PROMPT_MAX_OUTPUT_BYTES) {
      limitReason = 'max_output_bytes'
      break
    }

    limitedItems.push(item)
    totalBytes += candidateBytes
  }

  if (!limitReason) return limitedItems
  return {
    items: limitedItems,
    truncated: true,
    limitReason
  }
}

function isPluginPathAllowed(
  targetPath: string | undefined,
  ctx: ToolContext,
  mode: 'read' | 'write'
): boolean {
  const perms = ctx.channelPermissions
  if (!perms) return true // No plugin context — defer to normal approval logic

  if (!targetPath) return mode === 'read'
  const normalized = normalizePath(targetPath)
  const normalizedWorkDir = ctx.workingFolder ? normalizePath(ctx.workingFolder) : ''
  const normalizedHome = ctx.channelHomedir ? normalizePath(ctx.channelHomedir) : ''

  // Always allow access within plugin working directory
  if (normalizedWorkDir && (normalized + '/').startsWith(normalizedWorkDir + '/')) return true

  const homePrefix = normalizedHome.length > 0 ? normalizedHome + '/' : ''
  const isUnderHome = homePrefix.length > 0 && (normalized + '/').startsWith(homePrefix)

  if (mode === 'read') {
    if (!isUnderHome) return true
    if (perms.allowReadHome) return true
    return perms.readablePathPrefixes.some((prefix) => {
      const np = normalizePath(prefix)
      return (normalized + '/').startsWith(np + '/')
    })
  }

  // Write mode
  if (isUnderHome && !perms.allowWriteOutside) return false
  return perms.allowWriteOutside
}

const readHandler: ToolHandler = {
  definition: {
    name: 'Read',
    description: 'Read a file from the filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Number of lines to read' }
      },
      required: ['file_path']
    }
  },
  execute: async (input, ctx) => {
    const inputPath = getFileToolInputPath(input)
    if (!inputPath) {
      throw new Error('Read requires a non-empty "file_path" string')
    }
    const resolvedPath = resolveToolPath(inputPath, ctx.workingFolder)
    if (isSsh(ctx)) {
      const result = await ctx.ipc.invoke(
        IPC.SSH_FS_READ_FILE,
        sshArgs(ctx, {
          path: resolvedPath,
          offset: input.offset,
          limit: input.limit,
          raw: false
        })
      )
      if (isErrorResult(result)) throw new Error(`Read failed: ${result.error}`)
      await recordRead(ctx, resolvedPath)
      return String(result)
    }
    const result = await ctx.ipc.invoke(IPC.FS_READ_FILE, {
      path: resolvedPath,
      offset: input.offset,
      limit: input.limit,
      raw: false
    })
    if (isErrorResult(result)) throw new Error(`Read failed: ${result.error}`)
    await recordRead(ctx, resolvedPath)
    if (
      result &&
      typeof result === 'object' &&
      (result as Record<string, unknown>).type === 'image'
    ) {
      const img = result as { mediaType: string; data: string }
      return [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, mediaType: img.mediaType, data: img.data }
        }
      ]
    }
    return String(result)
  },
  requiresApproval: (input, ctx) => {
    const inputPath = getFileToolInputPath(input)
    if (!inputPath) return false
    if (ctx.channelPermissions) {
      const filePath = resolveToolPath(inputPath, ctx.workingFolder)
      return !isPluginPathAllowed(filePath, ctx, 'read')
    }
    return false
  }
}

const writeHandler: ToolHandler = {
  definition: {
    name: 'Write',
    description:
      "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        content: { type: 'string', description: 'The content to write to the file' }
      },
      required: ['file_path', 'content']
    }
  },
  execute: async (input, ctx) => {
    const inputPath = getFileToolInputPath(input)
    if (!inputPath) {
      throw new Error('Write requires a non-empty "file_path" string')
    }
    if (typeof input.content !== 'string') {
      throw new Error('Write requires a "content" string')
    }

    const resolvedPath = resolveToolPath(inputPath, ctx.workingFolder)
    const guardError = await assertCurrentFileMatchesLastRead({
      ctx,
      filePath: resolvedPath,
      toolName: 'Write',
      allowMissingFile: true
    })
    if (guardError) throw new Error(guardError)

    if (isSsh(ctx)) {
      const result = await ctx.ipc.invoke(
        IPC.SSH_FS_WRITE_FILE,
        sshWriteArgs(ctx, resolvedPath, input.content, 'Write')
      )
      if (isErrorResult(result)) throw new Error(`Write failed: ${result.error}`)
      await recordRead(ctx, resolvedPath)
      return encodeStructuredToolResult({
        success: true,
        path: resolvedPath,
        ...(result && typeof result === 'object' && 'op' in result && typeof result.op === 'string'
          ? { op: result.op }
          : {})
      })
    }
    const result = await ctx.ipc.invoke(
      IPC.FS_WRITE_FILE,
      localWriteArgs(ctx, resolvedPath, input.content, 'Write')
    )
    if (isErrorResult(result)) {
      throw new Error(`Write failed: ${result.error}`)
    }
    await recordRead(ctx, resolvedPath)

    return encodeStructuredToolResult({
      success: true,
      path: resolvedPath,
      ...(result && typeof result === 'object' && 'op' in result && typeof result.op === 'string'
        ? { op: result.op }
        : {})
    })
  },
  requiresApproval: (input, ctx) => {
    const inputPath = getFileToolInputPath(input)
    if (!inputPath) return false
    const filePath = resolveToolPath(inputPath, ctx.workingFolder)
    if (ctx.channelPermissions) {
      return !isPluginPathAllowed(filePath, ctx, 'write')
    }
    if (!ctx.workingFolder) return true
    return !filePath.startsWith(ctx.workingFolder)
  }
}

const editHandler: ToolHandler = {
  definition: {
    name: 'Edit',
    description:
      'Performs exact string replacements in files. \n\nUsage:\n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`. \n- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        old_string: {
          type: 'string',
          description: 'The text to replace'
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with (must be different from old_string)'
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurences of old_string (default false)'
        }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  execute: async (input, ctx) => {
    const inputPath = getFileToolInputPath(input)
    if (!inputPath) {
      return encodeToolError('Edit requires a non-empty "file_path" string')
    }
    const resolvedPath = resolveToolPath(inputPath, ctx.workingFolder)
    const oldStr = String(input.old_string ?? '')
    const newStr = String(input.new_string ?? '')
    const replaceAll = Boolean(input.replace_all)

    if (!oldStr) {
      return encodeToolError('old_string must be non-empty')
    }

    if (oldStr === newStr) {
      return encodeToolError('new_string must be different from old_string')
    }

    const guardError = await assertCurrentFileMatchesLastRead({
      ctx,
      filePath: resolvedPath,
      toolName: 'Edit',
      allowMissingFile: false
    })
    if (guardError) return encodeToolError(guardError)

    const readCh = isSsh(ctx) ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE
    const readArgs = isSsh(ctx) ? sshArgs(ctx, { path: resolvedPath }) : { path: resolvedPath }
    const contentResult = await ctx.ipc.invoke(readCh, readArgs)
    if (isErrorResult(contentResult)) {
      return encodeToolError(`Read failed: ${contentResult.error}`)
    }

    const content = String(contentResult)
    const editResult = applyExactReplacement({ content, oldStr, newStr, replaceAll })
    if ('error' in editResult) return encodeToolError(editResult.error)
    const updated = editResult.updated

    const writeCh = isSsh(ctx) ? IPC.SSH_FS_WRITE_FILE : IPC.FS_WRITE_FILE
    const writeArgs = isSsh(ctx)
      ? sshWriteArgs(ctx, resolvedPath, updated, 'Edit', content)
      : localWriteArgs(ctx, resolvedPath, updated, 'Edit', content)
    const writeResult = await ctx.ipc.invoke(writeCh, writeArgs)
    if (isErrorResult(writeResult)) {
      return encodeToolError(`Write failed: ${writeResult.error}`)
    }

    await recordRead(ctx, resolvedPath)
    return encodeStructuredToolResult({
      success: true,
      path: resolvedPath,
      replaceAll
    })
  },
  requiresApproval: (input, ctx) => {
    if (isSsh(ctx)) return false
    const inputPath = getFileToolInputPath(input)
    if (!inputPath) return false
    const filePath = resolveToolPath(inputPath, ctx.workingFolder)
    if (ctx.channelPermissions) {
      return !isPluginPathAllowed(filePath, ctx, 'write')
    }
    if (!ctx.workingFolder) return true
    return !filePath.startsWith(ctx.workingFolder)
  }
}

const notebookEditHandler: ToolHandler = {
  definition: {
    name: 'NotebookEdit',
    description: 'Edit a Jupyter notebook cell by index or cell_id.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: {
          type: 'string',
          description: 'Notebook path, absolute or relative to the working folder'
        },
        file_path: {
          type: 'string',
          description: 'Alias for notebook_path'
        },
        cell_id: { type: 'string', description: 'Cell id to edit' },
        cell_index: { type: 'number', description: 'Zero-based cell index' },
        mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
          description: 'Edit mode. Defaults to replace.'
        },
        new_source: { type: 'string', description: 'New cell source' },
        source: { type: 'string', description: 'Alias for new_source' },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown', 'raw'],
          description: 'Cell type for inserted or replaced cells'
        }
      },
      required: []
    }
  },
  execute: async (input, ctx) => {
    const rawPath =
      typeof input.notebook_path === 'string' && input.notebook_path.trim()
        ? input.notebook_path
        : input.file_path
    const resolvedPath = resolveToolPath(rawPath, ctx.workingFolder)
    if (!resolvedPath || resolvedPath === '.') {
      return encodeToolError('NotebookEdit requires notebook_path or file_path')
    }
    const guardError = await assertCurrentFileMatchesLastRead({
      ctx,
      filePath: resolvedPath,
      toolName: 'NotebookEdit',
      allowMissingFile: false
    })
    if (guardError) return encodeToolError(guardError)

    const readCh = isSsh(ctx) ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE
    const readArgs = isSsh(ctx) ? sshArgs(ctx, { path: resolvedPath }) : { path: resolvedPath }
    const contentResult = await ctx.ipc.invoke(readCh, readArgs)
    if (isErrorResult(contentResult)) return encodeToolError(`Read failed: ${contentResult.error}`)

    let notebook: { cells?: unknown[] }
    try {
      notebook = JSON.parse(String(contentResult)) as { cells?: unknown[] }
    } catch (error) {
      return encodeToolError(
        `Invalid notebook JSON: ${error instanceof Error ? error.message : error}`
      )
    }

    if (!Array.isArray(notebook.cells)) {
      return encodeToolError('Notebook does not contain a cells array')
    }

    const mode = input.mode === 'insert' || input.mode === 'delete' ? input.mode : 'replace'
    const cellIndex =
      typeof input.cell_index === 'number'
        ? Math.floor(input.cell_index)
        : typeof input.cell_id === 'string'
          ? notebook.cells.findIndex(
              (cell) =>
                !!cell &&
                typeof cell === 'object' &&
                (cell as { id?: unknown; cell_id?: unknown }).id === input.cell_id
            )
          : mode === 'insert'
            ? notebook.cells.length - 1
            : -1

    if (mode !== 'insert' && (cellIndex < 0 || cellIndex >= notebook.cells.length)) {
      return encodeToolError('Notebook cell not found')
    }
    if (mode === 'insert' && (cellIndex < -1 || cellIndex >= notebook.cells.length)) {
      return encodeToolError('Insert cell_index is out of range')
    }

    if (mode === 'delete') {
      notebook.cells.splice(cellIndex, 1)
    } else {
      const source = String(input.new_source ?? input.source ?? '')
      const cellType =
        input.cell_type === 'markdown' || input.cell_type === 'raw' || input.cell_type === 'code'
          ? input.cell_type
          : 'code'
      const sourceLines = source
        ? source.endsWith('\n')
          ? source.split(/(?<=\n)/)
          : source.split(/(?<=\n)/)
        : []
      const nextCell = {
        cell_type: cellType,
        metadata: {},
        source: sourceLines
      }
      if (cellType === 'code') Object.assign(nextCell, { outputs: [], execution_count: null })
      if (mode === 'insert') notebook.cells.splice(cellIndex + 1, 0, nextCell)
      else notebook.cells[cellIndex] = { ...(notebook.cells[cellIndex] as object), ...nextCell }
    }

    const updated = `${JSON.stringify(notebook, null, 1)}\n`
    const writeCh = isSsh(ctx) ? IPC.SSH_FS_WRITE_FILE : IPC.FS_WRITE_FILE
    const writeArgs = isSsh(ctx)
      ? sshWriteArgs(ctx, resolvedPath, updated, 'NotebookEdit', String(contentResult))
      : localWriteArgs(ctx, resolvedPath, updated, 'NotebookEdit', String(contentResult))
    const writeResult = await ctx.ipc.invoke(writeCh, writeArgs)
    if (isErrorResult(writeResult)) return encodeToolError(`Write failed: ${writeResult.error}`)

    await recordRead(ctx, resolvedPath)
    return encodeStructuredToolResult({ success: true, path: resolvedPath, mode })
  },
  requiresApproval: (input, ctx) => {
    if (isSsh(ctx)) return false
    const rawPath =
      typeof input.notebook_path === 'string' && input.notebook_path.trim()
        ? input.notebook_path
        : input.file_path
    const filePath = resolveToolPath(rawPath, ctx.workingFolder)
    if (ctx.channelPermissions) {
      return !isPluginPathAllowed(filePath, ctx, 'write')
    }
    if (!ctx.workingFolder) return true
    return !filePath.startsWith(ctx.workingFolder)
  }
}

const lsHandler: ToolHandler = {
  definition: {
    name: 'LS',
    description: 'List files and directories in a given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or relative to the working folder' },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns to ignore'
        }
      },
      required: []
    }
  },
  execute: async (input, ctx) => {
    const rawPath = typeof input.path === 'string' ? input.path.trim() : ''
    if ((!rawPath || rawPath === '.') && !ctx.workingFolder?.trim()) {
      return encodeToolError(
        'LS requires an active working folder when path is omitted or set to `.`'
      )
    }

    const resolvedPath = resolveToolPath(input.path, ctx.workingFolder)
    if (isSsh(ctx)) {
      const result = await ctx.ipc.invoke(
        IPC.SSH_FS_LIST_DIR,
        sshArgs(ctx, {
          path: resolvedPath,
          limit: LS_BACKEND_FETCH_LIMIT
        })
      )
      return encodeStructuredToolResult(formatLsResultForPrompt(result))
    }
    const result = await ctx.ipc.invoke(IPC.FS_LIST_DIR, {
      path: resolvedPath,
      ignore: input.ignore,
      limit: LS_BACKEND_FETCH_LIMIT
    })
    return encodeStructuredToolResult(formatLsResultForPrompt(result))
  },
  requiresApproval: (input, ctx) => {
    if (ctx.channelPermissions) {
      const targetPath = resolveToolPath(input.path, ctx.workingFolder)
      return !isPluginPathAllowed(targetPath, ctx, 'read')
    }
    return false
  }
}

export function registerFsTools(): void {
  toolRegistry.register(readHandler)
  toolRegistry.register(writeHandler)
  toolRegistry.register(editHandler)
  toolRegistry.register(notebookEditHandler)
  toolRegistry.register(lsHandler)
}

function isErrorResult(value: unknown): value is { error: string } {
  if (!value || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0
}
