import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { encodeToolError } from '@renderer/lib/tools/tool-result-format'
import type {
  ExtensionFetchResponse,
  ExtensionInstance,
  ExtensionToolDefinition,
  ExtensionToolResult
} from '../../../../shared/extension-types'
import { useExtensionStore } from '@renderer/stores/extension-store'
import { executeJsExtensionTool } from './extension-sandbox-runtime'
import { encodeExtensionToolResult } from './extension-result'

const EXTENSION_TOOL_PREFIX = 'extension__'
let registeredExtensionToolNames: string[] = []
let refreshPromise: Promise<void> | null = null

type ObjectInputSchema = Extract<
  ToolHandler['definition']['inputSchema'],
  { properties: Record<string, unknown> }
>

export function extensionToolName(extensionId: string, toolName: string): string {
  return `${EXTENSION_TOOL_PREFIX}${extensionId}__${toolName}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeObjectInputSchema(schema: Record<string, unknown>): ObjectInputSchema {
  return {
    type: 'object',
    properties: isRecord(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof schema.additionalProperties === 'boolean'
      ? { additionalProperties: schema.additionalProperties }
      : {})
  }
}

function normalizeToolInputSchema(
  schema: Record<string, unknown>
): ToolHandler['definition']['inputSchema'] {
  if (Array.isArray(schema.oneOf)) {
    const oneOf = schema.oneOf
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => normalizeObjectInputSchema(item))
    if (oneOf.length > 0) {
      return {
        type: 'object',
        oneOf
      }
    }
  }
  return normalizeObjectInputSchema(schema)
}

function isReadOnlyTool(tool: ExtensionToolDefinition): boolean {
  if (typeof tool.readOnly === 'boolean') return tool.readOnly
  if (tool.kind === 'http') return (tool.http?.method ?? 'GET').toUpperCase() === 'GET'
  return false
}

function normalizeJsResult(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition,
  value: unknown
): Omit<ExtensionToolResult, '__openCoworkExtensionResult'> {
  if (isRecord(value)) {
    return {
      extensionId: extension.id,
      toolName: tool.name,
      ...(typeof value.text === 'string' ? { text: value.text } : {}),
      ...('data' in value ? { data: value.data } : {}),
      ...(isRecord(value.ui) ? { ui: value.ui as ExtensionToolResult['ui'] } : {})
    }
  }
  return {
    extensionId: extension.id,
    toolName: tool.name,
    text: typeof value === 'string' ? value : JSON.stringify(value),
    data: value
  }
}

function normalizeHttpResult(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition,
  response: ExtensionFetchResponse
): Omit<ExtensionToolResult, '__openCoworkExtensionResult'> {
  const data = response.json !== undefined ? response.json : response.text
  return {
    extensionId: extension.id,
    toolName: tool.name,
    text: response.ok
      ? `HTTP ${response.status} ${response.statusText}`.trim()
      : `HTTP request failed: ${response.status} ${response.statusText}`.trim(),
    data: {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: data
    }
  }
}

async function executeHttpTool(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition,
  input: Record<string, unknown>
): Promise<string> {
  const result = (await ipcClient.invoke(IPC.EXTENSION_FETCH, {
    extensionId: extension.id,
    toolName: tool.name,
    input
  })) as { success: boolean; response?: ExtensionFetchResponse; error?: string }

  if (!result.success || !result.response) {
    return encodeToolError(result.error ?? 'Extension HTTP tool failed')
  }
  return encodeExtensionToolResult(normalizeHttpResult(extension, tool, result.response))
}

function createExtensionToolHandler(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition
): ToolHandler {
  return {
    definition: {
      name: extensionToolName(extension.id, tool.name),
      description: `[Extension: ${extension.manifest.name}] ${tool.description}`,
      inputSchema: normalizeToolInputSchema(tool.inputSchema)
    },
    execute: async (input: Record<string, unknown>) => {
      if (tool.kind === 'http') {
        return await executeHttpTool(extension, tool, input)
      }
      const value = await executeJsExtensionTool(extension, tool, input)
      return encodeExtensionToolResult(normalizeJsResult(extension, tool, value))
    },
    requiresApproval: () => !isReadOnlyTool(tool)
  }
}

export function unregisterExtensionTools(): void {
  for (const name of registeredExtensionToolNames) {
    toolRegistry.unregister(name)
  }
  registeredExtensionToolNames = []
}

export async function refreshExtensionTools(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    await useExtensionStore.getState().loadExtensions()
    unregisterExtensionTools()

    const names: string[] = []
    for (const extension of useExtensionStore.getState().extensions) {
      if (!extension.enabled) continue
      for (const tool of extension.manifest.tools) {
        const handler = createExtensionToolHandler(extension, tool)
        toolRegistry.register(handler)
        names.push(handler.definition.name)
      }
    }
    registeredExtensionToolNames = names
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

export function isExtensionToolsRegistered(): boolean {
  return registeredExtensionToolNames.length > 0
}
