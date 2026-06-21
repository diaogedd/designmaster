import { app, ipcMain, shell } from 'electron'
import { URL } from 'url'
import { readConfig, writeConfig } from './secure-key-store'

const client_id = 'DesignMasterMCP_NativeApp'
const LOGIN_URL = `https://apextares.cn/connect/authorize?response_type=code&scope=openid%20profile`
const CUSTOM_SCHEME = 'opencowork'
const CUSTOM_CALLBACK_PREFIX = `${CUSTOM_SCHEME}://auth/callback`

interface LoginCallbackPayload {
  requestId: string
  success: boolean
  code?: string
  error?: string
}

const sessions = new Map<
  string,
  {
    resolved: boolean
    sender: Electron.WebContents
  }
>()
let activeRequestId: string | null = null

function ensureProtocolClient(): void {
  try {
    if (!app.isDefaultProtocolClient(CUSTOM_SCHEME)) {
      app.setAsDefaultProtocolClient(CUSTOM_SCHEME)
    }
  } catch (err) {
    console.warn('[Login] Failed to register protocol client:', err)
  }
}

function emitCallbackFromUrl(rawUrl: string): void {
  try {
    const callbackUrl = new URL(rawUrl)
    if (!rawUrl.startsWith(CUSTOM_CALLBACK_PREFIX)) return

    const requestId =
      callbackUrl.searchParams.get('state') ||
      callbackUrl.searchParams.get('requestId') ||
      activeRequestId
    if (!requestId) return

    const session = sessions.get(requestId)
    if (!session || session.resolved) return

    const error = callbackUrl.searchParams.get('error')
    if (error) {
      session.resolved = true
      session.sender.send('login:callback', {
        requestId,
        success: false,
        error: callbackUrl.searchParams.get('error_description') || error || 'OAuth login failed'
      } satisfies LoginCallbackPayload)
      cleanup(requestId)
      return
    }

    const code = callbackUrl.searchParams.get('code')
    if (!code) {
      session.sender.send('login:callback', {
        requestId,
        success: false,
        error: 'No code received'
      } satisfies LoginCallbackPayload)
      cleanup(requestId)
      return
    }

    const config = readConfig()
    config['loginAuthCode'] = code
    config['loginAuthCallbackUrl'] = rawUrl
    writeConfig(config)

    session.resolved = true
    session.sender.send('login:callback', {
      requestId,
      success: true,
      code
    } satisfies LoginCallbackPayload)
    cleanup(requestId)
  } catch (err) {
    console.warn('[Login] Failed to handle auth callback:', err)
  }
}

export function registerLoginHandlers(): void {
  ensureProtocolClient()

  app.on('open-url', (_event, rawUrl) => {
    console.log('open-url', rawUrl)
    emitCallbackFromUrl(rawUrl)
  })

  app.on('second-instance', (_event, commandLine) => {
    const callbackArg = commandLine.find((arg) => arg.startsWith(`${CUSTOM_SCHEME}://`))
    console.log('second-instance', callbackArg)
    if (callbackArg) {
      emitCallbackFromUrl(callbackArg)
    }
  })

  ipcMain.handle('login:start', async (event) => {
    const requestId = `login-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessions.set(requestId, { resolved: false, sender: event.sender })
    activeRequestId = requestId

    const redirectUri = encodeURIComponent(CUSTOM_CALLBACK_PREFIX)
    const loginUrl = `${LOGIN_URL}&client_id=${client_id}&redirect_uri=${redirectUri}`
    console.log('loginUrl',loginUrl)
    // void shell.openExternal(loginUrl)

    return { requestId, redirectUri }
  })

  ipcMain.handle('login:stop', async (_event, args: { requestId: string }) => {
    cleanup(args.requestId)
    return { success: true }
  })

  ipcMain.handle('login:check', async () => {
    const config = readConfig()
    const token = config['loginToken']
    return {
      hasToken: typeof token === 'string' && token.length > 0,
      token: typeof token === 'string' && token.length > 0 ? token : undefined
    }
  })
}

function cleanup(requestId: string): void {
  if (!sessions.has(requestId)) return
  sessions.delete(requestId)
  if (activeRequestId === requestId) activeRequestId = null
}
