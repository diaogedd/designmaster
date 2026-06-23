import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useSettingsStore } from '@renderer/stores/settings-store'

interface LoginCallbackPayload {
  requestId: string
  success: boolean
  code?: string
  accessToken?: string
  expiresAt?: number
  error?: string
}

export function LoginPage(): React.JSX.Element {
  const { t } = useTranslation('common')
  const setLogin = useSettingsStore((s) => s.setLogin)
  const [loading, setLoading] = useState(false)
  const currentRequestIdRef = useRef<string | null>(null)

  useEffect(() => {
    const off = ipcClient.on('login:callback', (data: unknown) => {
      const payload = data as LoginCallbackPayload
      if (payload.requestId !== currentRequestIdRef.current) return

      if (payload.success) {
        setLogin(true)
        setLoading(false)
        toast.success(
          t('login.success', {
            defaultValue: payload.accessToken ? 'Login successful' : 'Login code received'
          })
        )
      } else {
        toast.error(payload.error || t('login.callbackFailed', { defaultValue: 'Login failed' }))
        setLoading(false)
      }
    })

    return () => {
      off()
    }
  }, [setLogin, t])

  const startLogin = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = (await ipcClient.invoke('login:start')) as {
        requestId: string
        redirectUri: string
      }
      currentRequestIdRef.current = result.requestId
      toast.info(t('login.waiting', { defaultValue: 'Waiting for login...' }))
    } catch {
      toast.error(t('login.openFailed', { defaultValue: 'Failed to start login' }))
      setLoading(false)
    }
  }

  const handleRetryLogin = async (): Promise<void> => {
    const requestId = currentRequestIdRef.current
    if (requestId) {
      try {
        await ipcClient.invoke('login:stop', { requestId })
      } catch {
        // Ignore stop errors and start a fresh login attempt.
      }
      currentRequestIdRef.current = null
    }
    await startLogin()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-6 text-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('login.title', { defaultValue: 'Welcome' })}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('login.description', { defaultValue: 'Please log in to continue' })}
          </p>
        </div>

        <div className="space-y-3">
          <Button
            className="w-full"
            size="lg"
            onClick={() => void startLogin()}
            disabled={loading}
          >
            {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
            {loading
              ? t('login.waiting', { defaultValue: 'Waiting for login...' })
              : t('login.loginButton', { defaultValue: '登录' })}
          </Button>

          {loading && (
            <Button
              className="w-full"
              size="lg"
              variant="outline"
              onClick={() => void handleRetryLogin()}
            >
              {t('login.retryButton', { defaultValue: '重新登录' })}
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {t('login.hint', {
            defaultValue:
              'After clicking login, complete authentication in the browser. The token will be received securely and never transmitted in plaintext.'
          })}
        </p>
      </div>
    </div>
  )
}
