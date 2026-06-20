import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ExtensionInstance, ExtensionToolDefinition } from '../../../../shared/extension-types'

const SANDBOX_SOURCE = 'open_cowork_extension_sandbox'
const SANDBOX_TIMEOUT_MS = 30_000

function escapeScriptContent(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script')
}

function buildSandboxDocument(entryCode: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;" />
  </head>
  <body>
    <script>
      globalThis.fetch = () => Promise.reject(new Error('Direct fetch is disabled in OpenCowork extension sandboxes. Use ctx.fetch instead.'));
      globalThis.XMLHttpRequest = undefined;
      globalThis.WebSocket = undefined;
      globalThis.EventSource = undefined;
    </script>
    <script>${escapeScriptContent(entryCode)}</script>
    <script>
      (() => {
        const source = ${JSON.stringify(SANDBOX_SOURCE)};
        let rpcSeq = 0;
        const rpcPending = new Map();
        const post = (payload) => window.parent.postMessage({ source, ...payload }, '*');
        const rpc = (kind, payload) => new Promise((resolve, reject) => {
          const rpcId = 'rpc_' + (++rpcSeq);
          rpcPending.set(rpcId, { resolve, reject });
          post({ type: 'rpc', rpcId, kind, payload });
        });
        const storage = {
          get: (key) => rpc('storage-get', { key }),
          set: (key, value) => rpc('storage-set', { key, value }),
          delete: (key) => rpc('storage-delete', { key })
        };

        window.addEventListener('message', async (event) => {
          const data = event.data;
          if (!data || data.source !== source) return;

          if (data.type === 'rpc-result') {
            const pending = rpcPending.get(data.rpcId);
            if (!pending) return;
            rpcPending.delete(data.rpcId);
            if (data.error) pending.reject(new Error(data.error));
            else pending.resolve(data.result);
            return;
          }

          if (data.type !== 'call') return;

          try {
            const extension = globalThis.openCoworkExtension;
            const handler = extension && extension.handlers && extension.handlers[data.handler];
            if (typeof handler !== 'function') {
              throw new Error('Extension handler not found: ' + data.handler);
            }
            const ctx = Object.freeze({
              config: Object.freeze(data.config || {}),
              fetch: (request) => rpc('fetch', { request }),
              storage
            });
            const result = await handler(data.input || {}, ctx);
            post({ type: 'result', callId: data.callId, result });
          } catch (error) {
            post({
              type: 'result',
              callId: data.callId,
              error: error && error.message ? error.message : String(error)
            });
          }
        });

        post({ type: 'ready' });
      })();
    </script>
  </body>
</html>`
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function readExtensionAsset(extensionId: string, assetPath: string): Promise<string> {
  const result = (await ipcClient.invoke(IPC.EXTENSION_READ_ASSET, {
    id: extensionId,
    path: assetPath
  })) as { content?: string; error?: string }
  if (result.error) throw new Error(result.error)
  return result.content ?? ''
}

async function handleSandboxRpc(
  extensionId: string,
  kind: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (kind === 'fetch') {
    const result = (await ipcClient.invoke(IPC.EXTENSION_FETCH, {
      extensionId,
      request: normalizeRecord(payload.request)
    })) as { success: boolean; response?: unknown; error?: string }
    if (!result.success) throw new Error(result.error ?? 'Extension fetch failed')
    return result.response
  }
  if (kind === 'storage-get') {
    return await ipcClient.invoke(IPC.EXTENSION_STORAGE_GET, {
      extensionId,
      key: String(payload.key ?? '')
    })
  }
  if (kind === 'storage-set') {
    return await ipcClient.invoke(IPC.EXTENSION_STORAGE_SET, {
      extensionId,
      key: String(payload.key ?? ''),
      value: payload.value
    })
  }
  if (kind === 'storage-delete') {
    return await ipcClient.invoke(IPC.EXTENSION_STORAGE_DELETE, {
      extensionId,
      key: String(payload.key ?? '')
    })
  }
  throw new Error(`Unknown extension sandbox RPC: ${kind}`)
}

export async function executeJsExtensionTool(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition,
  input: Record<string, unknown>
): Promise<unknown> {
  if (!extension.manifest.entry) {
    throw new Error(`Extension "${extension.id}" does not define an entry file`)
  }
  if (!tool.handler) {
    throw new Error(`Extension tool "${tool.name}" does not define a handler`)
  }

  const entryCode = await readExtensionAsset(extension.id, extension.manifest.entry)
  const iframe = document.createElement('iframe')
  iframe.sandbox.add('allow-scripts')
  iframe.style.display = 'none'
  iframe.srcdoc = buildSandboxDocument(entryCode)

  return await new Promise((resolve, reject) => {
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`
    let settled = false
    const cleanup = (): void => {
      window.removeEventListener('message', onMessage)
      iframe.remove()
    }
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      cleanup()
      fn()
    }
    const timer = window.setTimeout(() => {
      settle(() => reject(new Error('Extension handler timed out')))
    }, SANDBOX_TIMEOUT_MS)

    const postCall = (): void => {
      iframe.contentWindow?.postMessage(
        {
          source: SANDBOX_SOURCE,
          type: 'call',
          callId,
          handler: tool.handler,
          input,
          config: extension.config
        },
        '*'
      )
    }

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow) return
      const data = normalizeRecord(event.data)
      if (data.source !== SANDBOX_SOURCE) return

      if (data.type === 'ready') {
        postCall()
        return
      }

      if (data.type === 'rpc') {
        const rpcId = String(data.rpcId ?? '')
        const kind = String(data.kind ?? '')
        void handleSandboxRpc(extension.id, kind, normalizeRecord(data.payload))
          .then((result) => {
            iframe.contentWindow?.postMessage(
              { source: SANDBOX_SOURCE, type: 'rpc-result', rpcId, result },
              '*'
            )
          })
          .catch((error) => {
            iframe.contentWindow?.postMessage(
              {
                source: SANDBOX_SOURCE,
                type: 'rpc-result',
                rpcId,
                error: error instanceof Error ? error.message : String(error)
              },
              '*'
            )
          })
        return
      }

      if (data.type === 'result' && data.callId === callId) {
        if (typeof data.error === 'string') {
          settle(() => reject(new Error(data.error as string)))
        } else {
          settle(() => resolve(data.result))
        }
      }
    }

    window.addEventListener('message', onMessage)
    document.body.appendChild(iframe)
  })
}
