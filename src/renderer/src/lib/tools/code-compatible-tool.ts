import { toolRegistry } from '../agent/tool-registry'
import { IPC } from '../ipc/channels'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function unavailable(name: string, details: string): ReturnType<typeof encodeStructuredToolResult> {
  return encodeStructuredToolResult({
    status: 'unavailable',
    tool: name,
    reason: details
  })
}

const todoWriteHandler: ToolHandler = {
  definition: {
    name: 'TodoWrite',
    description: 'Code-agent-compatible lightweight todo list update for the current turn.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: { type: 'object' },
          description: 'Todo entries with content/title and status'
        }
      },
      required: ['todos']
    }
  },
  execute: async (input) => {
    const todos = Array.isArray(input.todos) ? input.todos : []
    return encodeStructuredToolResult({
      success: true,
      todos,
      message:
        'TodoWrite accepted. OpenCowork persists durable work tracking through TaskCreate/TaskUpdate.'
    })
  },
  requiresApproval: () => false
}

const listMcpResourcesHandler: ToolHandler = {
  definition: {
    name: 'ListMcpResourcesTool',
    description: 'List resources exposed by connected MCP servers.',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'Optional MCP server ID' }
      }
    }
  },
  execute: async (input, ctx) => {
    const serverId = typeof input.serverId === 'string' ? input.serverId.trim() : ''
    if (serverId) {
      const resources = await ctx.ipc.invoke(IPC.MCP_LIST_RESOURCES, serverId)
      return encodeStructuredToolResult({ serverId, resources })
    }

    const servers = await ctx.ipc.invoke(IPC.MCP_LIST)
    if (!Array.isArray(servers)) return encodeStructuredToolResult({ servers, resources: [] })
    const resources = await Promise.all(
      servers
        .filter((server): server is { id: string; name?: string } => {
          return !!server && typeof server === 'object' && typeof server.id === 'string'
        })
        .map(async (server) => ({
          serverId: server.id,
          name: server.name,
          resources: await ctx.ipc.invoke(IPC.MCP_LIST_RESOURCES, server.id)
        }))
    )
    return encodeStructuredToolResult({ resources })
  },
  requiresApproval: () => false
}

const readMcpResourceHandler: ToolHandler = {
  definition: {
    name: 'ReadMcpResourceTool',
    description: 'Read a specific MCP resource by server ID and URI.',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'MCP server ID' },
        uri: { type: 'string', description: 'Resource URI' }
      },
      required: ['serverId', 'uri']
    }
  },
  execute: async (input, ctx) => {
    const serverId = String(input.serverId ?? '')
    const uri = String(input.uri ?? '')
    if (!serverId || !uri) return encodeToolError('serverId and uri are required')
    const result = await ctx.ipc.invoke(IPC.MCP_READ_RESOURCE, { serverId, uri })
    return encodeStructuredToolResult({ result })
  },
  requiresApproval: () => false
}

const toolSearchHandler: ToolHandler = {
  definition: {
    name: 'ToolSearch',
    description: 'Search currently available built-in, skill, subagent, and MCP tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum results' }
      }
    }
  },
  execute: async (input) => {
    const query = String(input.query ?? '').toLowerCase()
    const limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(Math.floor(input.limit), 50))
        : 20
    const allMatches = toolRegistry.getDefinitions().filter((definition) => {
      if (!query) return true
      return (
        definition.name.toLowerCase().includes(query) ||
        String(definition.description ?? '')
          .toLowerCase()
          .includes(query)
      )
    })
    const matches = allMatches.slice(0, limit).map((definition) => ({
      name: definition.name,
      description: definition.description
    }))
    return encodeStructuredToolResult({ total: allMatches.length, tools: matches })
  },
  requiresApproval: () => false
}

const powerShellHandler: ToolHandler = {
  definition: {
    name: 'PowerShell',
    description: 'Execute a command through Windows PowerShell.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' }
      },
      required: ['command']
    }
  },
  execute: async (input, ctx) => {
    if (window.electron.process.platform !== 'win32') {
      return unavailable('PowerShell', 'PowerShell is only exposed on Windows.')
    }
    const command = String(input.command ?? '')
    if (!command.trim()) return encodeToolError('PowerShell requires command')
    const result = await ctx.ipc.invoke(IPC.SHELL_EXEC, {
      command,
      timeout: input.timeout,
      cwd: ctx.workingFolder,
      shell: 'powershell.exe'
    })
    return encodeStructuredToolResult({ result })
  },
  requiresApproval: () => true
}

const monitorHandler: ToolHandler = {
  definition: {
    name: 'Monitor',
    description:
      'Run a background command and monitor its output through OpenCowork background tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run in the background' },
        description: { type: 'string', description: 'Short monitor description' }
      },
      required: ['command']
    }
  },
  execute: async (input, ctx) => {
    const command = String(input.command ?? '')
    if (!command.trim()) return encodeToolError('Monitor requires command')
    const result = await ctx.ipc.invoke(IPC.PROCESS_SPAWN, {
      command,
      cwd: ctx.workingFolder,
      metadata: {
        source: 'monitor-tool',
        sessionId: ctx.sessionId,
        toolUseId: ctx.currentToolUseId,
        description: input.description
      }
    })
    return encodeStructuredToolResult({ result })
  },
  requiresApproval: () => true
}

export function registerCodeCompatibleTools(): void {
  toolRegistry.register(todoWriteHandler)
  toolRegistry.register(listMcpResourcesHandler)
  toolRegistry.register(readMcpResourceHandler)
  toolRegistry.register(toolSearchHandler)
  if (window.electron.process.platform === 'win32') {
    toolRegistry.register(powerShellHandler)
  }
  toolRegistry.register(monitorHandler)
}
