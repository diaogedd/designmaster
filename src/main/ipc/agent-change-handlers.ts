import { createHash } from 'crypto'
import * as fs from 'fs'
import { ipcMain } from 'electron'
import {
  appendStoredFileChange,
  deleteStoredFinalizedRunChangeSetsOlderThan,
  getStoredRunChangeSet,
  listStoredRunChangeSetsBySession,
  markFileChangeReverted,
  recomputeRunStatus
} from '../db/agent-changes-dao'

export type RunChangeStatus = 'open' | 'reverted'
export type FileChangeStatus = 'open' | 'reverted'
type ChangeOp = 'create' | 'modify'
type ChangeTransport = 'local' | 'ssh'

interface ChangeMeta {
  runId?: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
}

interface ListSessionRunChangesArgs {
  sessionId: string
}

export interface FileSnapshot {
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

interface TrackedFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: ChangeTransport
  connectionId?: string
  op: ChangeOp
  status: FileChangeStatus
  before: FileSnapshot
  after: FileSnapshot
  createdAt: number
  revertedAt?: number
}

interface RunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: RunChangeStatus
  changes: TrackedFileChange[]
  createdAt: number
  updatedAt: number
}

interface SshChangeAdapter {
  readSnapshot: (connectionId: string, filePath: string) => Promise<FileSnapshot>
  writeText: (connectionId: string, filePath: string, content: string) => Promise<void>
  deleteFile: (connectionId: string, filePath: string) => Promise<void>
}

let sshChangeAdapter: SshChangeAdapter | null = null

const INLINE_TEXT_SNAPSHOT_LIMIT_BYTES = 64 * 1024
const SNAPSHOT_PREVIEW_HEAD_CHARS = 1200
const SNAPSHOT_PREVIEW_TAIL_CHARS = 400
const FINALIZED_RUN_CHANGES_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

let lastPruneAt = 0
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function buildFileSnapshot(exists: boolean, text?: string): FileSnapshot {
  if (!exists) {
    return {
      exists: false,
      hash: null,
      size: 0
    }
  }

  if (text === undefined) {
    return buildOpaqueExistingSnapshot()
  }

  const normalizedText = text
  const size = Buffer.byteLength(normalizedText, 'utf-8')
  const lineCount =
    normalizedText.length === 0 ? 0 : normalizedText.replace(/\r\n/g, '\n').split('\n').length
  if (size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return {
      exists: true,
      text: normalizedText,
      fullText: normalizedText,
      hash: hashText(normalizedText),
      size,
      lineCount
    }
  }

  return {
    exists: true,
    fullText: normalizedText,
    previewText: normalizedText.slice(0, SNAPSHOT_PREVIEW_HEAD_CHARS),
    ...(normalizedText.length > SNAPSHOT_PREVIEW_TAIL_CHARS
      ? { tailPreviewText: normalizedText.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS) }
      : {}),
    textOmitted: true,
    hash: hashText(normalizedText),
    size,
    lineCount
  }
}

function buildLightSnapshot(text: string): FileSnapshot {
  const size = Buffer.byteLength(text, 'utf-8')
  const lineCount = text.length === 0 ? 0 : text.replace(/\r\n/g, '\n').split('\n').length
  if (size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return {
      exists: true,
      text,
      fullText: text,
      hash: hashText(text),
      size,
      lineCount
    }
  }

  return {
    exists: true,
    previewText: text.slice(0, SNAPSHOT_PREVIEW_HEAD_CHARS),
    ...(text.length > SNAPSHOT_PREVIEW_TAIL_CHARS
      ? { tailPreviewText: text.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS) }
      : {}),
    textOmitted: true,
    hash: hashText(text),
    size,
    lineCount
  }
}

export function buildOpaqueExistingSnapshot(): FileSnapshot {
  return {
    exists: true,
    hash: null,
    size: 0
  }
}

function pruneStaleRunChangesIfNeeded(): void {
  const now = Date.now()
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  deleteStoredFinalizedRunChangeSetsOlderThan(now - FINALIZED_RUN_CHANGES_RETENTION_MS)
}

function resolveRunId(meta?: ChangeMeta): string | null {
  const runId = meta?.runId?.trim()
  if (runId) return runId
  const toolUseId = meta?.toolUseId?.trim()
  if (toolUseId) return toolUseId
  return null
}

function recordTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  before: FileSnapshot
  afterText: string
  transport: ChangeTransport
  connectionId?: string
}): void {
  const runId = resolveRunId(args.meta)
  if (!runId) {
    console.warn(
      '[agent-changes] dropping change record: no runId or toolUseId in meta',
      args.filePath
    )
    return
  }

  const after = buildLightSnapshot(args.afterText)
  if (args.before.exists === after.exists && args.before.hash === after.hash) {
    return
  }

  const now = Date.now()
  const sessionId = args.meta?.sessionId?.trim() || undefined
  const assistantMessageId = args.meta?.runId?.trim() || runId
  const existingForId = getStoredRunChangeSet(runId)
  const sequence = (existingForId?.changes.length ?? 0) + 1

  const change: TrackedFileChange = {
    id: `${runId}:${sequence}`,
    runId,
    sessionId,
    toolUseId: args.meta?.toolUseId,
    toolName: args.meta?.toolName,
    filePath: args.filePath,
    transport: args.transport,
    connectionId: args.connectionId,
    op: args.before.exists ? 'modify' : 'create',
    status: 'open',
    before: args.before,
    after,
    createdAt: now
  }

  appendStoredFileChange({
    runId,
    sessionId,
    assistantMessageId,
    change,
    now
  })
}

export function recordLocalTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  beforeExists: boolean
  beforeText?: string
  afterText: string
}): void {
  recordTextWriteChange({
    meta: args.meta,
    filePath: args.filePath,
    before: buildFileSnapshot(args.beforeExists, args.beforeText),
    afterText: args.afterText,
    transport: 'local'
  })
}

export function recordSshTextWriteChange(args: {
  meta?: ChangeMeta
  connectionId: string
  filePath: string
  before: FileSnapshot
  afterText: string
}): void {
  recordTextWriteChange({
    meta: args.meta,
    filePath: args.filePath,
    before: args.before,
    afterText: args.afterText,
    transport: 'ssh',
    connectionId: args.connectionId
  })
}

export function registerSshChangeAdapter(adapter: SshChangeAdapter): void {
  sshChangeAdapter = adapter
}

function cloneSnapshot(snapshot: FileSnapshot): FileSnapshot {
  return {
    exists: snapshot.exists,
    text:
      snapshot.text ??
      (snapshot.size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES ? snapshot.fullText : undefined),
    previewText: snapshot.previewText,
    tailPreviewText: snapshot.tailPreviewText,
    textOmitted: snapshot.textOmitted,
    hash: snapshot.hash,
    size: snapshot.size,
    lineCount: snapshot.lineCount
  }
}

function hydrateLocalAfterSnapshot(
  change: TrackedFileChange,
  snapshot: FileSnapshot
): FileSnapshot {
  const cloned = cloneSnapshot(snapshot)
  if (cloned.text !== undefined) return cloned
  if (change.transport !== 'local' || snapshot.size > INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return cloned
  }
  if (!snapshot.hash || !fs.existsSync(change.filePath)) return cloned

  const stats = fs.statSync(change.filePath)
  if (!stats.isFile() || stats.size > INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) return cloned

  const text = fs.readFileSync(change.filePath, 'utf-8')
  if (hashText(text) !== snapshot.hash) return cloned

  return {
    ...cloned,
    text
  }
}

function cloneChange(change: TrackedFileChange): TrackedFileChange {
  return {
    ...change,
    before: cloneSnapshot(change.before),
    after: hydrateLocalAfterSnapshot(change, change.after)
  }
}

function cloneRunChangeSet(changeSet: RunChangeSet): RunChangeSet {
  return {
    ...changeSet,
    changes: changeSet.changes.map(cloneChange)
  }
}

function loadRunChangeSet(runId: string): RunChangeSet | null {
  return (getStoredRunChangeSet(runId) as RunChangeSet | null) ?? null
}

function getRunChangeSetsBySession(sessionId: string): RunChangeSet[] {
  pruneStaleRunChangesIfNeeded()
  return (listStoredRunChangeSetsBySession(sessionId) as RunChangeSet[]).map(cloneRunChangeSet)
}

function findChange(
  runId: string,
  changeId: string
): { changeSet: RunChangeSet; change: TrackedFileChange } | null {
  const changeSet = loadRunChangeSet(runId)
  if (!changeSet) return null
  const change = changeSet.changes.find((entry) => entry.id === changeId)
  if (!change) return null
  return { changeSet, change }
}

function resolveSnapshotFullText(snapshot: FileSnapshot): string | null {
  if (!snapshot.exists) return ''
  return snapshot.fullText ?? snapshot.text ?? null
}

async function getChangeDiffContent(
  runId: string,
  changeId: string
): Promise<{ beforeText: string; afterText: string } | { error: string } | null> {
  const found = findChange(runId, changeId)
  if (!found) return null

  const beforeText = resolveSnapshotFullText(found.change.before)
  let afterText = resolveSnapshotFullText(found.change.after)

  if (afterText === null && found.change.status === 'open') {
    if (found.change.transport === 'local') {
      try {
        const currentText = fs.readFileSync(found.change.filePath, 'utf-8')
        if (hashText(currentText) === found.change.after.hash) {
          afterText = currentText
        }
      } catch {
        // file may have been deleted or changed
      }
    } else if (found.change.connectionId && sshChangeAdapter) {
      try {
        const snap = await sshChangeAdapter.readSnapshot(
          found.change.connectionId,
          found.change.filePath
        )
        const snapText = resolveSnapshotFullText(snap)
        if (snapText !== null && hashText(snapText) === found.change.after.hash) {
          afterText = snapText
        }
      } catch {
        // SSH connection may be unavailable
      }
    }
  }

  if (beforeText === null || afterText === null) {
    return { error: 'Full diff is unavailable for this change' }
  }

  return { beforeText, afterText }
}

async function forceRollback(
  change: TrackedFileChange
): Promise<{ reverted: boolean; reason?: string }> {
  if (change.op === 'create') {
    if (change.transport === 'local') {
      try {
        fs.rmSync(change.filePath, { force: true })
      } catch (err) {
        return { reverted: false, reason: String(err) }
      }
    } else {
      if (!change.connectionId || !sshChangeAdapter) {
        return { reverted: false, reason: 'SSH change adapter is unavailable' }
      }
      try {
        await sshChangeAdapter.deleteFile(change.connectionId, change.filePath)
      } catch (err) {
        return { reverted: false, reason: String(err) }
      }
    }

    change.status = 'reverted'
    change.revertedAt = Date.now()
    return { reverted: true }
  }

  const beforeText = resolveSnapshotFullText(change.before)
  if (change.before.exists && beforeText === null) {
    return {
      reverted: false,
      reason: 'Original content was not captured in full (file too large at capture time)'
    }
  }

  const targetText = beforeText ?? ''
  if (change.transport === 'local') {
    try {
      fs.writeFileSync(change.filePath, targetText, 'utf-8')
    } catch (err) {
      return { reverted: false, reason: String(err) }
    }
  } else {
    if (!change.connectionId || !sshChangeAdapter) {
      return { reverted: false, reason: 'SSH change adapter is unavailable' }
    }
    try {
      await sshChangeAdapter.writeText(change.connectionId, change.filePath, targetText)
    } catch (err) {
      return { reverted: false, reason: String(err) }
    }
  }

  change.status = 'reverted'
  change.revertedAt = Date.now()
  return { reverted: true }
}

async function undoRunChangeSet(runId: string): Promise<{
  success: boolean
  revertedCount: number
  failureCount: number
  failures: Array<{ changeId: string; filePath: string; reason: string }>
  changeset: RunChangeSet | null
}> {
  const changeSet = loadRunChangeSet(runId)
  if (!changeSet) {
    return {
      success: false,
      revertedCount: 0,
      failureCount: 0,
      failures: [],
      changeset: null
    }
  }

  let revertedCount = 0
  let failureCount = 0
  const failures: Array<{ changeId: string; filePath: string; reason: string }> = []

  for (const change of [...changeSet.changes].reverse()) {
    if (change.status !== 'open') continue
    const result = await forceRollback(change)
    if (result.reverted) {
      revertedCount += 1
      markFileChangeReverted({
        runId,
        changeId: change.id,
        revertedAt: change.revertedAt ?? Date.now()
      })
    } else {
      failureCount += 1
      failures.push({
        changeId: change.id,
        filePath: change.filePath,
        reason: result.reason ?? 'Unknown error'
      })
    }
  }

  recomputeRunStatus(runId)
  const refreshed = loadRunChangeSet(runId)

  return {
    success: failureCount === 0,
    revertedCount,
    failureCount,
    failures,
    changeset: refreshed ? cloneRunChangeSet(refreshed) : null
  }
}

async function undoFileChange(
  runId: string,
  changeId: string
): Promise<{
  success: boolean
  reason?: string
  changeset: RunChangeSet | null
}> {
  const found = findChange(runId, changeId)
  if (!found) {
    return { success: false, reason: 'Change not found', changeset: null }
  }

  if (found.change.status === 'reverted') {
    return { success: true, changeset: cloneRunChangeSet(found.changeSet) }
  }

  const result = await forceRollback(found.change)
  if (result.reverted) {
    markFileChangeReverted({
      runId,
      changeId,
      revertedAt: found.change.revertedAt ?? Date.now()
    })
  }
  recomputeRunStatus(runId)
  const refreshed = loadRunChangeSet(runId)

  return {
    success: result.reverted,
    reason: result.reason,
    changeset: refreshed ? cloneRunChangeSet(refreshed) : null
  }
}

export function registerAgentChangeHandlers(): void {
  ipcMain.handle('agent:changes:list-session', async (_event, args: ListSessionRunChangesArgs) => {
    try {
      if (!args?.sessionId) return []
      return getRunChangeSetsBySession(args.sessionId)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'agent:changes:diff-content',
    async (_event, args: { runId: string; changeId: string }) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        return await getChangeDiffContent(args.runId, args.changeId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('agent:changes:undo-run', async (_event, args: { runId: string }) => {
    try {
      if (!args?.runId) return { error: 'runId is required' }
      return await undoRunChangeSet(args.runId)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'agent:changes:undo-file',
    async (_event, args: { runId: string; changeId: string }) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        return await undoFileChange(args.runId, args.changeId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )
}
