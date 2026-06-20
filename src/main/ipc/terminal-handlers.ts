import { ipcMain, BrowserWindow, type WebContents } from 'electron'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { accessSync, constants, statSync } from 'fs'
import { safeSendToWindow } from '../window-ipc'
import { spawn, type IPty } from 'node-pty'
import { readShellEnvironmentVariablesText } from './settings-handlers'

interface TerminalSession {
  id: string
  pty: IPty
  windowId: number | null
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  title: string
  command?: string
  nextSeq: number
  outputBuffer: TerminalOutputChunk[]
  outputBufferBytes: number
  exitCode?: number
  exitSignal?: number
}

interface ResolvedShellLaunch {
  shell: string
  args: string[]
}

interface CreateTerminalSessionArgs {
  cwd?: string
  shell?: string
  cols?: number
  rows?: number
  title?: string
  command?: string
}

interface CreateTerminalSessionResult {
  id?: string
  shell?: string
  cwd?: string
  cols?: number
  rows?: number
  createdAt?: number
  title?: string
  command?: string
  error?: string
}

interface TerminalOutputChunk {
  seq: number
  data: string
}

interface TerminalOutputEvent {
  id: string
  data: string
  seq: number
}

interface TerminalExitEvent {
  id: string
  exitCode: number
  signal?: number
}

interface TerminalSessionListEntry {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  title: string
  command?: string
  exitCode?: number
  exitSignal?: number
  buffer?: TerminalOutputChunk[]
}

const terminalSessions = new Map<string, TerminalSession>()
const terminalOutputListeners = new Set<(event: TerminalOutputEvent) => void>()
const terminalExitListeners = new Set<(event: TerminalExitEvent) => void>()
const TERMINAL_OUTPUT_BUFFER_MAX_BYTES = 64 * 1024

function isExecutableFile(filePath?: string): filePath is string {
  if (!filePath?.trim()) return false
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function getShellLaunchCandidates(preferredShell?: string): ResolvedShellLaunch[] {
  if (process.platform === 'win32') {
    const preferred = preferredShell?.trim()
    if (preferred) {
      return [{ shell: preferred, args: [] }]
    }
    return [
      { shell: process.env.ComSpec?.trim() || 'cmd.exe', args: [] },
      { shell: 'powershell.exe', args: [] },
      { shell: 'pwsh.exe', args: [] }
    ]
  }

  const shells = [
    preferredShell?.trim(),
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh'
  ].filter(
    (candidate, index, list): candidate is string =>
      Boolean(candidate) && list.indexOf(candidate) === index
  )

  const launches = shells
    .filter((candidate) => isExecutableFile(candidate))
    .map((shell) => ({ shell, args: shell === '/bin/sh' ? [] : ['-i'] }))

  return launches.length > 0 ? launches : [{ shell: '/bin/sh', args: [] }]
}

function isUsableDirectory(dirPath?: string): dirPath is string {
  if (!dirPath?.trim()) return false
  try {
    return statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function resolveCwd(cwd?: string): string {
  if (isUsableDirectory(cwd)) return cwd
  const home = homedir()
  if (isUsableDirectory(home)) return home
  return process.cwd()
}

function resolveOwnerWindowId(sender?: WebContents | null): number | null {
  return sender ? (BrowserWindow.fromWebContents(sender)?.id ?? null) : null
}

function createWindowEvent(windowId: number | null, channel: string, payload: unknown): void {
  const win =
    (typeof windowId === 'number'
      ? BrowserWindow.getAllWindows().find((candidate) => candidate.id === windowId)
      : null) ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  safeSendToWindow(win, channel, payload)
}

function toTerminalSessionListEntry(
  session: TerminalSession,
  includeBuffer = true
): TerminalSessionListEntry {
  return {
    id: session.id,
    shell: session.shell,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    title: session.title,
    ...(session.command ? { command: session.command } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.exitSignal !== undefined ? { exitSignal: session.exitSignal } : {}),
    ...(includeBuffer ? { buffer: session.outputBuffer } : {})
  }
}

function emitTerminalOutput(event: TerminalOutputEvent): void {
  terminalOutputListeners.forEach((listener) => listener(event))
}

function emitTerminalExit(event: TerminalExitEvent): void {
  terminalExitListeners.forEach((listener) => listener(event))
}

function getShellName(shellPath: string): string {
  return (shellPath.split(/[\\/]/).pop() || shellPath).toLowerCase()
}

function isPowerShell(shellPath: string): boolean {
  const shellName = getShellName(shellPath)
  return (
    shellName === 'powershell.exe' ||
    shellName === 'powershell' ||
    shellName === 'pwsh.exe' ||
    shellName === 'pwsh'
  )
}

function getWindowsCommandArgs(shellPath: string, command?: string): string[] {
  if (!command?.trim()) return isPowerShell(shellPath) ? ['-NoLogo'] : []
  if (isPowerShell(shellPath)) return ['-NoLogo', '-NoProfile', '-Command', command]
  return ['/d', '/s', '/c', command]
}

function getPosixCommandArgs(launch: ResolvedShellLaunch, command?: string): string[] {
  if (!command?.trim()) return launch.args
  return ['-lc', command]
}

function getLaunchArgs(launch: ResolvedShellLaunch, command?: string): string[] {
  return process.platform === 'win32'
    ? getWindowsCommandArgs(launch.shell, command)
    : getPosixCommandArgs(launch, command)
}

const SHELL_ENVIRONMENT_VARIABLE_LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const POSIX_ENVIRONMENT_REFERENCE_RE =
  /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g
const WINDOWS_ENVIRONMENT_REFERENCE_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/g

function normalizeEnvironmentVariableKey(key: string): string {
  return process.platform === 'win32' ? key.toLowerCase() : key
}

function readEnvironmentVariable(env: NodeJS.ProcessEnv, key: string): string {
  const directValue = env[key]
  if (typeof directValue === 'string') return directValue
  if (process.platform !== 'win32') return ''

  const normalizedKey = normalizeEnvironmentVariableKey(key)
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (normalizeEnvironmentVariableKey(candidateKey) !== normalizedKey) continue
    return typeof candidateValue === 'string' ? candidateValue : ''
  }

  return ''
}

function writeEnvironmentVariable(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (process.platform === 'win32') {
    const normalizedKey = normalizeEnvironmentVariableKey(key)
    for (const candidateKey of Object.keys(env)) {
      if (candidateKey === key) continue
      if (normalizeEnvironmentVariableKey(candidateKey) !== normalizedKey) continue
      delete env[candidateKey]
    }
  }

  env[key] = value
}

function expandEnvironmentVariableReferences(value: string, env: NodeJS.ProcessEnv): string {
  return value
    .replace(WINDOWS_ENVIRONMENT_REFERENCE_RE, (_match, key: string) => {
      return readEnvironmentVariable(env, key)
    })
    .replace(POSIX_ENVIRONMENT_REFERENCE_RE, (_match, shortKey: string, bracedKey: string) => {
      return readEnvironmentVariable(env, shortKey || bracedKey)
    })
}

function buildTerminalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const configuredText = readShellEnvironmentVariablesText()
  let hasConfiguredTerm = false

  if (configuredText.trim()) {
    const lines = configuredText.split(/\r?\n/)

    lines.forEach((rawLine, index) => {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) return

      const match = line.match(SHELL_ENVIRONMENT_VARIABLE_LINE_RE)
      if (!match) {
        console.warn(
          `[Terminal] Ignoring invalid shell environment variable config at line ${index + 1}`
        )
        return
      }

      const [, key, rawValue] = match
      const expandedValue = expandEnvironmentVariableReferences(rawValue, env)
      writeEnvironmentVariable(env, key, expandedValue)
      if (normalizeEnvironmentVariableKey(key) === normalizeEnvironmentVariableKey('TERM')) {
        hasConfiguredTerm = true
      }
    })
  }

  if (!hasConfiguredTerm) {
    writeEnvironmentVariable(env, 'TERM', 'xterm-256color')
  }

  return env
}

export async function createTerminalSession(
  args: CreateTerminalSessionArgs,
  sender?: WebContents | null
): Promise<CreateTerminalSessionResult> {
  const launches = getShellLaunchCandidates(args.shell)
  const requestedCwd = args.cwd?.trim()
  const cwd = resolveCwd(requestedCwd)
  const cols = Math.max(20, Math.floor(args.cols ?? 80))
  const rows = Math.max(5, Math.floor(args.rows ?? 24))
  const id = `term-${randomUUID()}`
  let lastError = 'Unknown error'
  const ownerWindowId = resolveOwnerWindowId(sender)
  const env = buildTerminalEnvironment()

  for (const launch of launches) {
    try {
      const launchArgs = getLaunchArgs(launch, args.command)
      const pty = spawn(launch.shell, launchArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env
      })

      const session: TerminalSession = {
        id,
        pty,
        windowId: ownerWindowId,
        shell: launch.shell,
        cwd,
        cols,
        rows,
        createdAt: Date.now(),
        title: args.title?.trim() || launch.shell.split(/[\\/]/).pop() || launch.shell,
        command: args.command?.trim() || undefined,
        nextSeq: 0,
        outputBuffer: [],
        outputBufferBytes: 0
      }

      terminalSessions.set(id, session)
      createWindowEvent(
        session.windowId,
        'terminal:created',
        toTerminalSessionListEntry(session, false)
      )

      pty.onData((data) => {
        const chunk = appendTerminalOutput(session, data)
        const payload = { id, data, seq: chunk.seq }
        createWindowEvent(session.windowId, 'terminal:output', payload)
        emitTerminalOutput(payload)
      })

      pty.onExit(({ exitCode, signal }) => {
        session.exitCode = exitCode
        session.exitSignal = signal
        const payload = { id, exitCode, signal }
        createWindowEvent(session.windowId, 'terminal:exit', payload)
        emitTerminalExit(payload)
      })

      return {
        id,
        shell: launch.shell,
        cwd,
        cols,
        rows,
        createdAt: session.createdAt,
        title: session.title,
        command: session.command
      }
    } catch (error) {
      const launchArgs = getLaunchArgs(launch, args.command)
      lastError = `${launch.shell}${launchArgs.length > 0 ? ` ${launchArgs.join(' ')}` : ''}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const cwdHint =
    requestedCwd && requestedCwd !== cwd
      ? ` Requested cwd: ${requestedCwd}. Fallback cwd: ${cwd}.`
      : ` Cwd: ${cwd}.`
  return {
    error: `Failed to start terminal shell.${cwdHint} Tried: ${launches
      .map((launch) => {
        const launchArgs = getLaunchArgs(launch, args.command)
        return `${launch.shell}${launchArgs.length > 0 ? ` ${launchArgs.join(' ')}` : ''}`
      })
      .join(', ')}. Last error: ${lastError}`
  }
}

function appendTerminalOutput(session: TerminalSession, data: string): TerminalOutputChunk {
  const chunk: TerminalOutputChunk = {
    seq: session.nextSeq + 1,
    data
  }

  session.nextSeq = chunk.seq
  session.outputBuffer.push(chunk)
  session.outputBufferBytes += Buffer.byteLength(data, 'utf8')

  while (
    session.outputBuffer.length > 1 &&
    session.outputBufferBytes > TERMINAL_OUTPUT_BUFFER_MAX_BYTES
  ) {
    const removed = session.outputBuffer.shift()
    if (!removed) break
    session.outputBufferBytes -= Buffer.byteLength(removed.data, 'utf8')
  }

  return chunk
}

export function onTerminalSessionOutput(
  listener: (event: TerminalOutputEvent) => void
): () => void {
  terminalOutputListeners.add(listener)
  return () => terminalOutputListeners.delete(listener)
}

export function onTerminalSessionExit(listener: (event: TerminalExitEvent) => void): () => void {
  terminalExitListeners.add(listener)
  return () => terminalExitListeners.delete(listener)
}

export function registerTerminalHandlers(): void {
  ipcMain.handle('terminal:create', async (event, args: CreateTerminalSessionArgs) => {
    return await createTerminalSession(args, event.sender)
  })

  ipcMain.handle('terminal:input', async (_event, args: { id: string; data: string }) => {
    const session = terminalSessions.get(args.id)
    if (!session) return { error: 'Terminal not found' }
    try {
      session.pty.write(args.data)
      return { success: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(
    'terminal:resize',
    async (_event, args: { id: string; cols: number; rows: number }) => {
      const session = terminalSessions.get(args.id)
      if (!session) return { error: 'Terminal not found' }
      try {
        const cols = Math.max(20, Math.floor(args.cols))
        const rows = Math.max(5, Math.floor(args.rows))
        session.cols = cols
        session.rows = rows
        session.pty.resize(cols, rows)
        return { success: true }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('terminal:kill', async (_event, args: { id: string }) => {
    return killTerminalSession(args.id)
  })

  ipcMain.handle('terminal:list', async () => {
    return Array.from(terminalSessions.values()).map((session) =>
      toTerminalSessionListEntry(session)
    )
  })
}

export function getTerminalSessionSnapshot(id: string): TerminalSession | undefined {
  const session = terminalSessions.get(id)
  return session ? { ...session, outputBuffer: [...session.outputBuffer] } : undefined
}

export function writeTerminalSession(id: string, data: string): { success?: true; error?: string } {
  const session = terminalSessions.get(id)
  if (!session) return { error: 'Terminal not found' }
  if (session.exitCode !== undefined) return { error: 'Terminal already exited' }
  try {
    session.pty.write(data)
    return { success: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function killTerminalSession(id: string): { success?: true; error?: string } {
  const session = terminalSessions.get(id)
  if (!session) return { error: 'Terminal not found' }
  try {
    session.pty.kill()
    return { success: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function killAllTerminalSessions(): void {
  terminalSessions.forEach((session) => {
    try {
      session.pty.kill()
    } catch {
      // ignore
    }
  })
  terminalSessions.clear()
}
