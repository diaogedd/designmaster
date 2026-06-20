import { BrowserWindow, ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import path from 'path'
import type {
  SpawnIsolatedTeamWorkerArgs,
  SpawnIsolatedTeamWorkerResult,
  StopIsolatedTeamWorkerArgs,
  StopIsolatedTeamWorkersArgs
} from '../../shared/team-runtime-types'

const workerWindows = new Map<
  string,
  { window: BrowserWindow; teamName: string; memberId: string }
>()

function buildWorkerUrl(args: SpawnIsolatedTeamWorkerArgs): string {
  const params = new URLSearchParams({
    ocWorker: 'team',
    teamName: args.teamName,
    memberId: args.memberId,
    memberName: args.memberName,
    prompt: args.prompt,
    ...(args.taskId ? { taskId: args.taskId } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.agentName ? { agentName: args.agentName } : {}),
    ...(args.workingFolder ? { workingFolder: args.workingFolder } : {}),
    ...(args.sshConnectionId ? { sshConnectionId: args.sshConnectionId } : {})
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}?${params.toString()}`
  }

  return `file://${__dirname.replace(/\\/g, '/')}/../renderer/index.html?${params.toString()}`
}

export async function spawnIsolatedTeamWorker(
  args: SpawnIsolatedTeamWorkerArgs
): Promise<SpawnIsolatedTeamWorkerResult> {
  const workerId = `team-worker-${nanoid(8)}`
  const workerWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  workerWindows.set(workerId, {
    window: workerWindow,
    teamName: args.teamName,
    memberId: args.memberId
  })

  const completion = new Promise<SpawnIsolatedTeamWorkerResult>((resolve) => {
    workerWindow.on('closed', () => {
      workerWindows.delete(workerId)
      resolve({ success: true, workerId })
    })
  })

  const target = buildWorkerUrl(args)
  if (process.env['ELECTRON_RENDERER_URL']) {
    await workerWindow.loadURL(target)
  } else {
    await workerWindow.loadURL(target)
  }

  return completion
}

export async function stopIsolatedTeamWorker(
  args: StopIsolatedTeamWorkerArgs
): Promise<{ success: true }> {
  const record = workerWindows.get(args.workerId)
  if (record && !record.window.isDestroyed()) {
    record.window.close()
  }
  workerWindows.delete(args.workerId)
  return { success: true }
}

export async function stopIsolatedTeamWorkers(
  args: StopIsolatedTeamWorkersArgs
): Promise<{ success: true }> {
  for (const [workerId, record] of workerWindows.entries()) {
    if (record.teamName !== args.teamName) continue
    if (!record.window.isDestroyed()) {
      record.window.close()
    }
    workerWindows.delete(workerId)
  }
  return { success: true }
}

export function stopAllIsolatedTeamWorkers(): void {
  for (const record of workerWindows.values()) {
    if (!record.window.isDestroyed()) {
      record.window.close()
    }
  }
  workerWindows.clear()
}

export function registerTeamWorkerHandlers(): void {
  ipcMain.handle('team-worker:spawn', async (_event, args: SpawnIsolatedTeamWorkerArgs) => {
    return spawnIsolatedTeamWorker(args)
  })

  ipcMain.handle('team-worker:stop', async (_event, args: StopIsolatedTeamWorkerArgs) => {
    return stopIsolatedTeamWorker(args)
  })

  ipcMain.handle('team-worker:stop-team', async (_event, args: StopIsolatedTeamWorkersArgs) => {
    return stopIsolatedTeamWorkers(args)
  })
}
