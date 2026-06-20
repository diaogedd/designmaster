import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface LoginCallbackPayload {
  requestId: string
  success: boolean
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
        toast.success(t('login.success', { defaultValue: 'Login successful' }))
      } else {
        toast.error(payload.error || t('login.callbackFailed', { defaultValue: 'Login failed' }))
        setLoading(false)
      }
    })

    return () => {
      off()
    }
  }, [setLogin, t])

  const handleLogin = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = (await ipcClient.invoke('login:start')) as {
        requestId: string
        port: number
        redirectUri: string
      }
      currentRequestIdRef.current = result.requestId
      // Main process opened the external login page automatically
      // The local HTTP server is now listening for the callback at result.redirectUri
    } catch {
      toast.error(t('login.openFailed', { defaultValue: 'Failed to start login' }))
      setLoading(false)
    }
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

        <Button
          className="w-full"
          size="lg"
          onClick={() => void handleLogin()}
          disabled={loading}
        >
          {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
          {loading
            ? t('login.waiting', { defaultValue: 'Waiting for login...' })
            : t('login.loginButton', { defaultValue: '登录' })}
        </Button>

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