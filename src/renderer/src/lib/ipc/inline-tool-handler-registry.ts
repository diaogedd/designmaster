import type { ToolHandler } from '@renderer/lib/tools/tool-types'

/**
 * Per-session inline tool handler registry consulted by the renderer tool
 * bridge before falling back to the global `toolRegistry`. This lets callers
 * like the wiki generator attach short-lived tool handlers (e.g.
 * SetWikiStructure) scoped to a single sidecar run without polluting the
 * global registry or requiring sidecar-side knowledge of the handler.
 *
 * Keyed by sessionId; each session may have multiple inline handlers, keyed
 * by tool name. Callers must `unregister` when their run completes.
 */
const registry = new Map<string, Map<string, ToolHandler>>()

export function registerInlineToolHandlers(
  sessionId: string,
  handlers: Record<string, ToolHandler>
): () => void {
  let bucket = registry.get(sessionId)
  if (!bucket) {
    bucket = new Map()
    registry.set(sessionId, bucket)
  }
  const added: string[] = []
  for (const [name, handler] of Object.entries(handlers)) {
    bucket.set(name, handler)
    added.push(name)
  }
  return () => {
    const current = registry.get(sessionId)
    if (!current) return
    for (const name of added) {
      current.delete(name)
    }
    if (current.size === 0) {
      registry.delete(sessionId)
    }
  }
}

export function getInlineToolHandler(
  sessionId: string | undefined,
  toolName: string
): ToolHandler | undefined {
  if (!sessionId) return undefined
  return registry.get(sessionId)?.get(toolName)
}
