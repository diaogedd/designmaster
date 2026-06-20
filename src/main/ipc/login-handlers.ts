import { ipcMain, shell } from 'electron'
import * as http from 'http'
import { URL } from 'url'
import { readConfig, writeConfig } from './secure-key-store'

const LOGIN_URL = 'http://47.242.151.54:8080/Account/login'

interface LoginSession {
  server: http.Server
  port: number
  resolved: boolean
  sender: Electron.WebContents
}

const sessions = new Map<string, LoginSession>()

function buildCallbackHtml(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Login Complete</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; color: #111; }
    .card { max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #ddd; border-radius: 12px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { margin: 0; color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Login Complete</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
}

export function registerLoginHandlers(): void {
  ipcMain.handle('login:start', async (event) => {
    const requestId = `login-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const sender = event.sender

    return new Promise<{ requestId: string; port: number; redirectUri: string }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url || '', 'http://localhost')
          const callbackPath = '/login/callback'

          if (reqUrl.pathname !== callbackPath) {
            res.statusCode = 404
            res.end('Not Found')
            return
          }

          const token = reqUrl.searchParams.get('token')

          const session = sessions.get(requestId)
          if (!session) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(buildCallbackHtml('Session expired. You can close this window.'))
            return
          }

          if (session.resolved) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(buildCallbackHtml('Login already processed. You can close this window.'))
            return
          }

          session.resolved = true
 
          if (!token) {
            sender.send('login:callback', { requestId, success: false, error: 'No token received' })
            res.statusCode = 400
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(buildCallbackHtml('No token received. You can close this window.'))
            cleanup(requestId)
            return
          }

          // Store token securely in main process config (never exposed to renderer)
          const config = readConfig()
          config['loginToken'] = token
          writeConfig(config)

          sender.send('login:callback', { requestId, success: true })

          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            buildCallbackHtml(
              'Login succeeded. Token has been stored. You can close this window and return to the application.'
            )
          )
          cleanup(requestId)
        } catch (err) {
          const session = sessions.get(requestId)
          if (session) {
            session.sender.send('login:callback', {
              requestId,
              success: false,
              error: err instanceof Error ? err.message : String(err)
            })
          }
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(buildCallbackHtml('Login failed. You can close this window.'))
          cleanup(requestId)
        }
      })

      server.on('error', (err) => {
        reject(err)
      })

      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const actualPort = typeof address === 'object' && address ? address.port : 0

        sessions.set(requestId, {
          server,
          port: actualPort,
          resolved: false,
          sender
        })

        const redirectUri = `http://127.0.0.1:${actualPort}/login/callback`

        // Open the external login page with the redirect_uri so the server
        // knows where to send the token back after authentication
        const loginUrl = `${LOGIN_URL}?redirect_uri=${encodeURIComponent(redirectUri)}`
        void shell.openExternal(loginUrl)

        resolve({ requestId, port: actualPort, redirectUri })
      })
    })
  })

  ipcMain.handle('login:stop', async (_event, args: { requestId: string }) => {
    cleanup(args.requestId)
    return { success: true }
  })

  ipcMain.handle('login:check', async () => {
    const config = readConfig()
    const token = config['loginToken']
    return { hasToken: typeof token === 'string' && token.length > 0 }
  })
}

function cleanup(requestId: string): void {
  const session = sessions.get(requestId)
  if (!session) return
  try {
    session.server.close()
  } catch {
    // ignore
  }
  sessions.delete(requestId)
}