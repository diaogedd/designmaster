import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FolderPlus, FolderOpen, Trash2, Puzzle, Save } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Separator } from '@renderer/components/ui/separator'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useExtensionStore } from '@renderer/stores/extension-store'
import { refreshExtensionTools } from '@renderer/lib/extensions/extension-tools'
import type { ExtensionInstance } from '../../../../shared/extension-types'

function ExtensionCard({ extension }: { extension: ExtensionInstance }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const updateExtension = useExtensionStore((state) => state.updateExtension)
  const removeExtension = useExtensionStore((state) => state.removeExtension)
  const openExtensionFolder = useExtensionStore((state) => state.openExtensionFolder)
  const [config, setConfig] = useState<Record<string, string>>(extension.config)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setConfig(extension.config)
  }, [extension.config])

  const configFields = extension.manifest.configSchema ?? []
  const network = extension.manifest.permissions?.network ?? []
  const readOnlyTools = useMemo(
    () =>
      extension.manifest.tools.filter((tool) => {
        if (typeof tool.readOnly === 'boolean') return tool.readOnly
        if (tool.kind === 'http') return (tool.http?.method ?? 'GET').toUpperCase() === 'GET'
        return false
      }).length,
    [extension.manifest.tools]
  )

  const handleToggle = async (enabled: boolean): Promise<void> => {
    const result = await updateExtension(extension.id, { enabled })
    if (!result.success) {
      toast.error(t('extension.updateFailed', { defaultValue: 'Failed to update extension' }), {
        description: result.error
      })
      return
    }
    await refreshExtensionTools()
  }

  const handleSaveConfig = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await updateExtension(extension.id, { config })
      if (!result.success) {
        toast.error(t('extension.saveFailed', { defaultValue: 'Failed to save configuration' }), {
          description: result.error
        })
        return
      }
      await refreshExtensionTools()
      toast.success(t('extension.saved', { defaultValue: 'Extension configuration saved' }))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('extension.removeConfirm', {
        defaultValue: 'Remove this extension?'
      }),
      description: extension.manifest.name,
      variant: 'destructive'
    })
    if (!ok) return
    const result = await removeExtension(extension.id)
    if (!result.success) {
      toast.error(t('extension.removeFailed', { defaultValue: 'Failed to remove extension' }), {
        description: result.error
      })
      return
    }
    await refreshExtensionTools()
  }

  const handleOpenFolder = async (): Promise<void> => {
    const result = await openExtensionFolder(extension.id)
    if (!result.success) {
      toast.error(t('extension.openFolderFailed', { defaultValue: 'Failed to open folder' }), {
        description: result.error
      })
    }
  }

  return (
    <section className="rounded-xl border border-border/60 bg-background p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-lg border border-border/60 bg-muted/35">
              <Puzzle className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-foreground">
                {extension.manifest.name}
              </h3>
              <p className="truncate text-xs text-muted-foreground">
                {extension.id} · v{extension.manifest.version}
              </p>
            </div>
          </div>
          {extension.manifest.description ? (
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {extension.manifest.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={extension.enabled ? 'secondary' : 'outline'}>
            {extension.enabled
              ? t('extension.enabled', { defaultValue: 'Enabled' })
              : t('extension.disabled', { defaultValue: 'Disabled' })}
          </Badge>
          <Switch
            checked={extension.enabled}
            onCheckedChange={(value) => void handleToggle(value)}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
          <div className="text-xs font-medium text-muted-foreground">
            {t('extension.tools', { defaultValue: 'Tools' })}
          </div>
          <div className="mt-1 text-lg font-semibold">{extension.manifest.tools.length}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t('extension.readOnlyCount', {
              defaultValue: '{{count}} read-only',
              count: readOnlyTools
            })}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
          <div className="text-xs font-medium text-muted-foreground">
            {t('extension.renderers', { defaultValue: 'Renderers' })}
          </div>
          <div className="mt-1 text-lg font-semibold">
            {extension.manifest.renderers?.length ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
          <div className="text-xs font-medium text-muted-foreground">
            {t('extension.network', { defaultValue: 'Network' })}
          </div>
          <div className="mt-1 truncate text-xs text-foreground/80">
            {network.length > 0
              ? network.join(', ')
              : t('extension.noNetwork', { defaultValue: 'No network access' })}
          </div>
        </div>
      </div>

      {configFields.length > 0 ? (
        <>
          <Separator className="my-4" />
          <div className="grid gap-3 md:grid-cols-2">
            {configFields.map((field) => (
              <label key={field.key} className="grid gap-1.5 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  {field.label}
                  {field.required ? ' *' : ''}
                </span>
                <Input
                  type={field.type === 'secret' ? 'password' : 'text'}
                  value={config[field.key] ?? ''}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                />
              </label>
            ))}
          </div>
          <div className="mt-3">
            <Button
              size="sm"
              className="gap-2"
              onClick={() => void handleSaveConfig()}
              disabled={saving}
            >
              <Save className="size-3.5" />
              {t('extension.saveConfig', { defaultValue: 'Save config' })}
            </Button>
          </div>
        </>
      ) : null}

      <Separator className="my-4" />
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {t('extension.tools', { defaultValue: 'Tools' })}
          </div>
          <div className="space-y-1.5">
            {extension.manifest.tools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-2.5 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{tool.name}</div>
                  <div className="truncate text-muted-foreground">{tool.description}</div>
                </div>
                <Badge variant="outline">{tool.kind}</Badge>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {t('extension.renderers', { defaultValue: 'Renderers' })}
          </div>
          <div className="space-y-1.5">
            {(extension.manifest.renderers ?? []).length > 0 ? (
              extension.manifest.renderers?.map((renderer) => (
                <div
                  key={renderer.name}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-2.5 py-2 text-xs"
                >
                  <span className="font-medium text-foreground">{renderer.name}</span>
                  <span className="truncate text-muted-foreground">{renderer.entry}</span>
                </div>
              ))
            ) : (
              <div className="rounded-md border border-dashed border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
                {t('extension.noRenderers', { defaultValue: 'No custom renderers' })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={() => void handleOpenFolder()}
        >
          <FolderOpen className="size-3.5" />
          {t('extension.openFolder', { defaultValue: 'Open folder' })}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="gap-2"
          onClick={() => void handleRemove()}
        >
          <Trash2 className="size-3.5" />
          {t('extension.remove', { defaultValue: 'Remove' })}
        </Button>
      </div>
    </section>
  )
}

export function ExtensionPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const extensions = useExtensionStore((state) => state.extensions)
  const loaded = useExtensionStore((state) => state.loaded)
  const loadExtensions = useExtensionStore((state) => state.loadExtensions)
  const installFromFolder = useExtensionStore((state) => state.installFromFolder)

  useEffect(() => {
    void loadExtensions()
  }, [loadExtensions])

  const handleInstall = async (): Promise<void> => {
    const selected = (await ipcClient.invoke(IPC.FS_SELECT_FOLDER)) as {
      canceled?: boolean
      path?: string
    }
    if (selected.canceled || !selected.path) return
    const result = await installFromFolder(selected.path)
    if (!result.success) {
      toast.error(t('extension.installFailed', { defaultValue: 'Failed to install extension' }), {
        description: result.error
      })
      return
    }
    await refreshExtensionTools()
    toast.success(t('extension.installed', { defaultValue: 'Extension installed' }))
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {t('extension.title', { defaultValue: 'Extensions' })}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t('extension.subtitle', {
              defaultValue:
                'Install local extensions that add custom Agent tools and response UI components.'
            })}
          </p>
        </div>
        <Button className="gap-2" onClick={() => void handleInstall()}>
          <FolderPlus className="size-4" />
          {t('extension.installFolder', { defaultValue: 'Install folder' })}
        </Button>
      </div>

      {!loaded ? (
        <div className="rounded-xl border border-border/60 bg-background p-6 text-sm text-muted-foreground">
          {t('extension.loading', { defaultValue: 'Loading extensions...' })}
        </div>
      ) : extensions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-background p-8 text-center">
          <Puzzle className="mx-auto size-8 text-muted-foreground/60" />
          <div className="mt-3 text-sm font-medium text-foreground">
            {t('extension.emptyTitle', { defaultValue: 'No extensions installed' })}
          </div>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {t('extension.emptyDesc', {
              defaultValue:
                'Choose a folder containing extension.json to add custom tools to OpenCowork.'
            })}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {extensions.map((extension) => (
            <ExtensionCard key={extension.id} extension={extension} />
          ))}
        </div>
      )}
    </div>
  )
}
