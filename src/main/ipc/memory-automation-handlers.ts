import { ipcMain } from 'electron'
import * as memoryAutomationDao from '../db/memory-automation-dao'
import * as memoryPipelineDao from '../db/memory-pipeline-dao'
import type {
  MemoryCitationEntry,
  MemoryAutomationListQuery,
  MemoryAutomationRecordInput,
  MemoryAutomationRunRollupArgs,
  MemoryAutomationUndoArgs,
  MemoryPipelineClearRootArgs,
  MemoryPipelineListJobsQuery,
  MemoryPipelineListRootsQuery,
  MemoryPipelineRunArgs,
  MemoryRootInput,
  MemoryStage1OutputInput
} from '../../shared/memory-automation-types'

function normalizeListQuery(value: unknown): MemoryAutomationListQuery {
  if (!value || typeof value !== 'object') return {}
  return value as MemoryAutomationListQuery
}

function asObject<T>(value: unknown): T {
  return (value && typeof value === 'object' ? value : {}) as T
}

function normalizeRoots(value: unknown): MemoryRootInput[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is MemoryRootInput => {
    if (!item || typeof item !== 'object') return false
    const record = item as Partial<MemoryRootInput>
    return (
      (record.scope === 'global' || record.scope === 'project') &&
      typeof record.rootPath === 'string' &&
      record.rootPath.trim().length > 0
    )
  })
}

function normalizeStage1Outputs(value: unknown): MemoryStage1OutputInput[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is MemoryStage1OutputInput => {
    if (!item || typeof item !== 'object') return false
    const record = item as Partial<MemoryStage1OutputInput>
    return (
      typeof record.memoryRootId === 'string' &&
      (record.scope === 'global' || record.scope === 'project') &&
      typeof record.sourceSessionId === 'string' &&
      typeof record.rawMemory === 'string' &&
      typeof record.rolloutSummary === 'string' &&
      typeof record.rolloutSlug === 'string' &&
      typeof record.fingerprint === 'string'
    )
  })
}

export function registerMemoryAutomationHandlers(): void {
  ipcMain.handle('memory-automation:list', (_event, query: unknown) => {
    return {
      entries: memoryAutomationDao.listMemoryAutomationEntries(normalizeListQuery(query))
    }
  })

  ipcMain.handle('memory-automation:record', (_event, input: MemoryAutomationRecordInput) => {
    try {
      const entry = memoryAutomationDao.addMemoryAutomationEntry(input)
      return { success: true, entry }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('memory-automation:undo', (_event, args: MemoryAutomationUndoArgs) => {
    try {
      const entry = memoryAutomationDao.markMemoryAutomationUndo(
        args.id,
        args.status ?? 'undone',
        args.error
      )
      if (!entry) {
        return { success: false, error: 'Memory automation entry not found' }
      }
      return { success: true, entry }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('memory-automation:run-session', () => {
    return {
      success: true,
      queued: false
    }
  })

  ipcMain.handle('memory-automation:run-rollup', (_event, args: MemoryAutomationRunRollupArgs) => {
    try {
      if (args.action === 'get-watermark') {
        if (!args.scope || !args.targetPath || !args.sourceDate || !args.contentHash) {
          return { success: false, error: 'Missing rollup watermark fields' }
        }
        return {
          success: true,
          alreadyProcessed: memoryAutomationDao.hasProcessedRollup({
            scope: args.scope,
            targetPath: args.targetPath,
            sourceDate: args.sourceDate,
            contentHash: args.contentHash
          })
        }
      }

      if (args.action === 'mark-watermark') {
        if (!args.scope || !args.targetPath || !args.sourceDate || !args.contentHash) {
          return { success: false, error: 'Missing rollup watermark fields' }
        }
        memoryAutomationDao.markProcessedRollup({
          scope: args.scope,
          target: 'project_memory',
          targetPath: args.targetPath,
          sourceDate: args.sourceDate,
          contentHash: args.contentHash
        })
        return { success: true, alreadyProcessed: true }
      }

      return { success: true, queued: false }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('memory-pipeline:run', (_event, rawArgs: unknown) => {
    const args = asObject<MemoryPipelineRunArgs>(rawArgs)
    try {
      if (args.action === 'prepare-session') {
        const roots = normalizeRoots(args.roots).map((root) =>
          memoryPipelineDao.ensureMemoryRoot(root)
        )
        const job = memoryPipelineDao.createMemoryJob({
          kind: 'stage1',
          status: 'running',
          sourceSessionId: args.sessionId ?? null,
          leaseOwner: args.leaseOwner ?? 'renderer'
        })
        return { success: true, roots, job }
      }

      if (args.action === 'ensure-roots') {
        const roots = normalizeRoots(args.roots).map((root) =>
          memoryPipelineDao.ensureMemoryRoot(root)
        )
        return { success: true, roots }
      }

      if (args.action === 'complete-stage1') {
        const stage1Outputs = normalizeStage1Outputs(args.stage1Outputs).map((output) =>
          memoryPipelineDao.addStage1Output(output)
        )
        let job = args.jobId
          ? memoryPipelineDao.finishMemoryJob({
              id: args.jobId,
              status:
                args.status ??
                (stage1Outputs.length > 0 ? 'succeeded' : 'succeeded_no_output'),
              error: args.error
            })
          : undefined
        if (!job && args.sessionId) {
          job = memoryPipelineDao.createMemoryJob({
            kind: 'stage1',
            status: stage1Outputs.length > 0 ? 'succeeded' : 'succeeded_no_output',
            sourceSessionId: args.sessionId
          })
        }
        return { success: true, stage1Outputs, job }
      }

      if (args.action === 'list-stage1-outputs') {
        if (!args.memoryRootId) {
          return { success: false, error: 'memoryRootId is required' }
        }
        return {
          success: true,
          stage1Outputs: memoryPipelineDao.listStage1Outputs({
            memoryRootId: args.memoryRootId,
            limit: args.limit
          })
        }
      }

      if (args.action === 'complete-phase2') {
        const rootId = args.memoryRootId ?? null
        const job =
          args.jobId && memoryPipelineDao.getMemoryJob(args.jobId)
            ? memoryPipelineDao.finishMemoryJob({
                id: args.jobId,
                status: args.status ?? (args.error ? 'failed' : 'succeeded'),
                error: args.error
              })
            : memoryPipelineDao.createMemoryJob({
                kind: 'phase2',
                status: args.status ?? (args.error ? 'failed' : 'succeeded'),
                memoryRootId: rootId,
                sourceSessionId: args.sessionId ?? null
              })
        if (args.error && job) {
          memoryPipelineDao.finishMemoryJob({ id: job.id, status: 'failed', error: args.error })
        }
        return { success: true, job: job ?? undefined }
      }

      if (args.action === 'record-job') {
        const job = memoryPipelineDao.createMemoryJob({
          kind: args.jobKind ?? 'phase2',
          status: args.status ?? 'running',
          memoryRootId: args.memoryRootId ?? null,
          sourceSessionId: args.sessionId ?? null,
          leaseOwner: args.leaseOwner ?? 'renderer'
        })
        return { success: true, job }
      }

      return { success: false, error: 'Unsupported memory pipeline action' }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('memory-pipeline:list-roots', (_event, rawQuery: unknown) => {
    try {
      return {
        roots: memoryPipelineDao.listMemoryRoots(asObject<MemoryPipelineListRootsQuery>(rawQuery))
      }
    } catch (error) {
      return {
        roots: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('memory-pipeline:list-jobs', (_event, rawQuery: unknown) => {
    try {
      return {
        jobs: memoryPipelineDao.listMemoryJobs(asObject<MemoryPipelineListJobsQuery>(rawQuery))
      }
    } catch (error) {
      return {
        jobs: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('memory-pipeline:clear-root', (_event, rawArgs: unknown) => {
    const args = asObject<MemoryPipelineClearRootArgs>(rawArgs)
    try {
      if (!args.memoryRootId) {
        return { success: false, error: 'memoryRootId is required' }
      }
      return {
        success: true,
        ...memoryPipelineDao.clearMemoryRoot(args)
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('memory:record-citation-usage', (_event, rawEntry: unknown) => {
    const entry = asObject<MemoryCitationEntry>(rawEntry)
    try {
      if (
        !entry.memoryRootId ||
        (entry.scope !== 'global' && entry.scope !== 'project') ||
        !entry.path
      ) {
        return { success: false, error: 'Invalid memory citation usage payload' }
      }
      memoryPipelineDao.recordCitationUsage(entry)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
