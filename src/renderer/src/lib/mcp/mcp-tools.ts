import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler, ToolContext } from '../tools/tool-types'
import type { McpServerConfig, McpTool } from './types'
import { IPC } from '../ipc/channels'

/**
 * MCP Tool Bridge — dynamically maps MCP server tools to ToolHandlers
 * registered in the global tool registry.
 *
 * Tool naming: `mcp__{serverId}__{toolName}`
 * This avoids conflicts between different servers and with built-in tools.
 */

const MCP_TOOL_PREFIX = 'mcp__'

/** Track registered MCP tool names for cleanup */
let _registeredMcpToolNames: string[] = []

/** Build a prefixed tool name */
function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`
}

/** Parse server ID and original tool name from a prefixed tool name */
export function parseMcpToolName(
  prefixedName: string
): { serverId: string; toolName: string } | null {
  if (!prefixedName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = prefixedName.slice(MCP_TOOL_PREFIX.length)
  const sepIdx = rest.indexOf('__')
  if (sepIdx === -1) return null
  return {
    serverId: rest.slice(0, sepIdx),
    toolName: rest.slice(sepIdx + 2)
  }
}

/** Check if a tool name is an MCP tool */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

/**
 * Register MCP tools for all active servers.
 * Each MCP tool becomes a ToolHandler that calls mcp:call-tool via IPC.
 */
export function registerMcpTools(
  activeServers: McpServerConfig[],
  toolsMap: Record<string, McpTool[]>
): void {
  // Unregister any previously registered MCP tools first
  unregisterMcpTools()

  const newNames: string[] = []

  for (const server of activeServers) {
    const tools = toolsMap[server.id]
    if (!tools?.length) continue

    for (const mcpTool of tools) {
      const name = mcpToolName(server.id, mcpTool.name)

      const handler: ToolHandler = {
        definition: {
          name,
          description: `[MCP: ${server.name}] ${mcpTool.description ?? mcpTool.name}`,
          inputSchema: {
            type: 'object',
            properties: (mcpTool.inputSchema?.properties as Record<string, unknown>) ?? {},
            required: (mcpTool.inputSchema?.required as string[]) ?? []
          }
        },
        execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
          try {
            const result = await ctx.ipc.invoke(IPC.MCP_CALL_TOOL, {
              serverId: server.id,
              toolName: mcpTool.name,
              args: input
            })
            const res = result as { success: boolean; result?: unknown; error?: string }
            if (!res.success) {
              return JSON.stringify({ error: res.error ?? 'MCP tool call failed' })
            }
            // MCP tool results follow the MCP CallToolResult format
            // which has a `content` array of TextContent/ImageContent/EmbeddedResource
            return JSON.stringify(res.result)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return JSON.stringify({ error: `MCP tool "${mcpTool.name}" failed: ${msg}` })
          }
        },
        // MCP tools require approval by default for safety
        requiresApproval: () => true
      }

      toolRegistry.register(handler)
      newNames.push(name)
    }
  }

  _registeredMcpToolNames = newNames
}

/** Unregister all previously registered MCP tools */
export function unregisterMcpTools(): void {
  for (const name of _registeredMcpToolNames) {
    toolRegistry.unregister(name)
  }
  _registeredMcpToolNames = []
}

/** Check if any MCP tools are currently registered */
export function isMcpToolsRegistered(): boolean {
  return _registeredMcpToolNames.length > 0
}

/** Get count of currently registered MCP tools */
export function getMcpToolCount(): number {
  return _registeredMcpToolNames.length
}
