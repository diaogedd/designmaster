import { app, ipcMain, shell } from 'electron'
import { URL } from 'url'
import * as https from 'https'
import * as http from 'http'
import { readConfig, writeConfig } from './secure-key-store'

const client_id = 'DesignMasterMCP_NativeApp'
const LOGIN_URL = `https://apextares.cn/connect/authorize?response_type=code&scope=openid%20profile`
const TOKEN_URL = `https://apextares.cn/connect/token`
const CUSTOM_SCHEME = 'designmaster'
const CUSTOM_CALLBACK_PREFIX = `${CUSTOM_SCHEME}://auth/callback`

// 提前 5 分钟刷新，避免 token 在使用中过期
const REFRESH_BEFORE_MS = 5 * 60 * 1000

// --- config keys ---
const KEY_ACCESS_TOKEN = 'loginAccessToken'
const KEY_REFRESH_TOKEN = 'loginRefreshToken'
const KEY_ID_TOKEN = 'loginIdToken'
const KEY_TOKEN_TYPE = 'loginTokenType'
const KEY_EXPIRES_AT = 'loginExpiresAt'

interface LoginCallbackPayload {
  requestId: string
  success: boolean
  code?: string
  accessToken?: string
  expiresAt?: number
  error?: string
}

interface TokenResponseJson {
  access_token?: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const sessions = new Map<
  string,
  {
    resolved: boolean
    sender: Electron.WebContents
  }
>()
let activeRequestId: string | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function ensureProtocolClient(): void {
  try {
    if (!app.isDefaultProtocolClient(CUSTOM_SCHEME)) {
      app.setAsDefaultProtocolClient(CUSTOM_SCHEME)
    }
  } catch (err) {
    console.warn('[Login] Failed to register protocol client:', err)
  }
}

// --- 通用 token endpoint POST 请求 ---
function postToTokenEndpoint(params: URLSearchParams): Promise<TokenResponseJson> {
  const body = params.toString()
  const parsedUrl = new URL(TOKEN_URL)
  const isHttps = parsedUrl.protocol === 'https:'
  const httpModule = isHttps ? https : http

  return new Promise((resolve) => {
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json'
      }
    }

    const req = httpModule.request(options, (res) => {
      let responseBody = ''
      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString()
      })
      res.on('end', () => {
        try {
          const data = JSON.parse(responseBody) as TokenResponseJson
          if (res.statusCode === 200 && data.access_token) {
            resolve(data)
          } else {
            console.error(
              `[Login] Token request failed: HTTP ${res.statusCode} — ${responseBody.slice(0, 500)}`
            )
            resolve({
              error: data.error || 'token_request_failed',
              error_description:
                data.error_description || `HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`
            })
          }
        } catch {
          console.error(`[Login] Token parse error: ${responseBody.slice(0, 500)}`)
          resolve({
            error: 'token_parse_error',
            error_description: `Failed to parse token response: ${responseBody.slice(0, 500)}`
          })
        }
      })
    })

    req.on('error', (err) => {
      console.error(`[Login] Token network error: ${err.message}`)
      resolve({
        error: 'token_network_error',
        error_description: err.message
      })
    })

    req.setTimeout(15000, () => {
      req.destroy()
      resolve({
        error: 'token_timeout',
        error_description: 'Token request timed out'
      })
    })

    req.write(body)
    req.end()
  })
}

// --- 用 authorization_code 换 token（首次登录）---
async function exchangeCodeForToken(code: string): Promise<TokenResponseJson> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CUSTOM_CALLBACK_PREFIX,
    client_id
  })

  return postToTokenEndpoint(params)
}

// --- 用 refresh_token 换新 token（保活）---
async function exchangeRefreshToken(refreshToken: string): Promise<TokenResponseJson> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id,
    scope: 'openid profile'
  })

  console.log('[Login] Refreshing token via refresh_token...')
  return postToTokenEndpoint(params)
}

// --- 持久化 token ---
function persistTokens(token: TokenResponseJson): void {
  const config = readConfig()
  config[KEY_ACCESS_TOKEN] = token.access_token
  if (token.refresh_token) {
    config[KEY_REFRESH_TOKEN] = token.refresh_token
  }
  if (token.id_token) {
    config[KEY_ID_TOKEN] = token.id_token
  }
  if (token.token_type) {
    config[KEY_TOKEN_TYPE] = token.token_type
  }
  if (typeof token.expires_in === 'number' && token.expires_in > 0) {
    config[KEY_EXPIRES_AT] = Date.now() + token.expires_in * 1000
  }
  writeConfig(config)
  console.log('[Login] Tokens persisted')

  // 主动定时保活：在 token 过期前自动刷新
  scheduleTokenRefresh(token.expires_in)
}

// --- 定时保活：提前 REFRESH_BEFORE_MS 刷新 ---
function scheduleTokenRefresh(expiresInSeconds?: number): void {
  // 清除上一次的定时器
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }

  if (typeof expiresInSeconds !== 'number' || expiresInSeconds <= 0) {
    console.log('[Login] No expires_in, skip proactive refresh scheduling')
    return
  }

  const delayMs = Math.max(expiresInSeconds * 1000 - REFRESH_BEFORE_MS, 30_000)
  console.log(
    `[Login] Scheduling proactive token refresh in ${Math.round(delayMs / 1000)}s (expires in ${expiresInSeconds}s)`
  )

  refreshTimer = setTimeout(() => {
    refreshTimer = null
    console.log('[Login] Proactive refresh timer fired')
    void tryRefreshAccessToken().then((result) => {
      if (result.success) {
        console.log('[Login] Proactive token refresh succeeded')
      } else {
        console.warn('[Login] Proactive token refresh failed:', result.error)
      }
    })
  }, delayMs)
}

// --- 尝试用 refresh_token 刷新 access_token ---
async function tryRefreshAccessToken(): Promise<{
  success: boolean
  accessToken?: string
  expiresAt?: number
  error?: string
}> {
  const config = readConfig()
  const refreshToken = config[KEY_REFRESH_TOKEN]

  if (typeof refreshToken !== 'string' || !refreshToken) {
    return { success: false, error: 'No refresh token available' }
  }

  const result = await exchangeRefreshToken(refreshToken)
  console.log('[Login] Refresh token response:', JSON.stringify(result, null, 2))

  if (result.error || !result.access_token) {
    // 刷新失败，清除过期 token 防止反复尝试
    if (result.error === 'invalid_grant') {
      console.warn('[Login] Refresh token is invalid, clearing tokens')
      const cleared = { ...config }
      delete cleared[KEY_ACCESS_TOKEN]
      delete cleared[KEY_REFRESH_TOKEN]
      delete cleared[KEY_ID_TOKEN]
      delete cleared[KEY_TOKEN_TYPE]
      delete cleared[KEY_EXPIRES_AT]
      writeConfig(cleared)
    }
    return {
      success: false,
      error: result.error_description || result.error || 'Token refresh failed'
    }
  }

  persistTokens(result)

  return {
    success: true,
    accessToken: result.access_token,
    expiresAt:
      typeof result.expires_in === 'number' ? Date.now() + result.expires_in * 1000 : undefined
  }
}

async function emitCallbackFromUrl(rawUrl: string): Promise<void> {
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

    // Exchange code for tokens
    console.log('[Login] Full token response:', JSON.stringify({ code }, null, 2))
    const tokenResult = await exchangeCodeForToken(code)

    if (tokenResult.error || !tokenResult.access_token) {
      session.resolved = true
      session.sender.send('login:callback', {
        requestId,
        success: false,
        error: tokenResult.error_description || tokenResult.error || 'Token exchange failed'
      } satisfies LoginCallbackPayload)
      cleanup(requestId)
      return
    }

    // Persist tokens locally
    persistTokens(tokenResult)

    session.resolved = true
    session.sender.send('login:callback', {
      requestId,
      success: true,
      code,
      accessToken: tokenResult.access_token,
      expiresAt:
        typeof tokenResult.expires_in === 'number'
          ? Date.now() + tokenResult.expires_in * 1000
          : undefined
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
    void emitCallbackFromUrl(rawUrl)
  })

  app.on('second-instance', (_event, commandLine) => {
    const callbackArg = commandLine.find((arg) => arg.startsWith(`${CUSTOM_SCHEME}://`))
    console.log('second-instance', callbackArg)
    if (callbackArg) {
      void emitCallbackFromUrl(callbackArg)
    }
  })

  ipcMain.handle('login:start', async (event) => {
    const requestId = `login-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessions.set(requestId, { resolved: false, sender: event.sender })
    activeRequestId = requestId

    const redirectUri = encodeURIComponent(CUSTOM_CALLBACK_PREFIX)
    const loginUrl = `${LOGIN_URL}&client_id=${client_id}&redirect_uri=${redirectUri}`
    console.log('loginUrl', loginUrl)
    void shell.openExternal(loginUrl)

    return { requestId, redirectUri }
  })

  ipcMain.handle('login:stop', async (_event, args: { requestId: string }) => {
    cleanup(args.requestId)
    return { success: true }
  })

  // 手动刷新 token
  ipcMain.handle('login:refresh', async () => {
    const result = await tryRefreshAccessToken()
    return result
  })

  // 检查登录状态 + 自动保活
  ipcMain.handle('login:check', async () => {
    const config = readConfig()
    const accessToken = config[KEY_ACCESS_TOKEN]
    const hasToken = typeof accessToken === 'string' && accessToken.length > 0

    const expiresAt = config[KEY_EXPIRES_AT]
    const isExpired = hasToken && typeof expiresAt === 'number' ? Date.now() >= expiresAt : false
    const willExpireSoon =
      hasToken && typeof expiresAt === 'number'
        ? Date.now() + REFRESH_BEFORE_MS >= expiresAt
        : false

    // 如果已过期或即将过期，尝试自动刷新
    if (hasToken && (isExpired || willExpireSoon)) {
      const hasRefreshToken =
        typeof config[KEY_REFRESH_TOKEN] === 'string' &&
        (config[KEY_REFRESH_TOKEN] as string).length > 0

      if (hasRefreshToken) {
        console.log(
          `[Login] Token ${isExpired ? 'expired' : 'expiring soon'}, attempting auto-refresh...`
        )
        const refreshResult = await tryRefreshAccessToken()
        if (refreshResult.success) {
          return {
            hasToken: true,
            isExpired: false,
            accessToken: refreshResult.accessToken,
            refreshToken: config[KEY_REFRESH_TOKEN],
            idToken:
              typeof config[KEY_ID_TOKEN] === 'string'
                ? (config[KEY_ID_TOKEN] as string)
                : undefined,
            tokenType:
              typeof config[KEY_TOKEN_TYPE] === 'string'
                ? (config[KEY_TOKEN_TYPE] as string)
                : undefined,
            expiresAt: refreshResult.expiresAt,
            refreshed: true
          }
        }
        console.warn('[Login] Auto-refresh failed:', refreshResult.error)
      }
    }

    return {
      hasToken,
      isExpired,
      accessToken: hasToken ? (accessToken as string) : undefined,
      refreshToken:
        typeof config[KEY_REFRESH_TOKEN] === 'string'
          ? (config[KEY_REFRESH_TOKEN] as string)
          : undefined,
      idToken:
        typeof config[KEY_ID_TOKEN] === 'string' ? (config[KEY_ID_TOKEN] as string) : undefined,
      tokenType:
        typeof config[KEY_TOKEN_TYPE] === 'string' ? (config[KEY_TOKEN_TYPE] as string) : undefined,
      expiresAt:
        typeof config[KEY_EXPIRES_AT] === 'number' ? (config[KEY_EXPIRES_AT] as number) : undefined
    }
  })
}

function cleanup(requestId: string): void {
  if (!sessions.has(requestId)) return
  sessions.delete(requestId)
  if (activeRequestId === requestId) activeRequestId = null
}
