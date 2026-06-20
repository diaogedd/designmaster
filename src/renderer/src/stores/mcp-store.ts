import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useChatStore } from '@renderer/stores/chat-store'
import type {
  McpServerConfig,
  McpServerStatus,
  McpTool,
  McpResource,
  McpPrompt,
  McpServerInfo
} from '@renderer/lib/mcp/types'
import { IPC } from '@renderer/lib/ipc/channels'

interface McpStore {
  servers: McpServerConfig[]
  serverStatuses: Record<string, McpServerStatus>
  serverTools: Record<string, McpTool[]>
  serverResources: Record<string, McpResource[]>
  serverPrompts: Record<string, McpPrompt[]>
  serverErrors: Record<string, string | undefined>

  // Per-project activation (toggled via + menu)
  activeMcpIdsByProject: Record<string, string[]>

  // Init
  loadServers: () => Promise<void>

  // CRUD
  addServer: (config: Omit<McpServerConfig, 'id' | 'createdAt'>) => Promise<string>
  updateServer: (id: string, patch: Partial<McpServerConfig>) => Promise<void>
  removeServer: (id: string) => Promise<void>

  // Connection management
  connectServer: (id: string) => Promise<string | undefined>
  disconnectServer: (id: string) => Promise<void>
  refreshServerInfo: (id: string) => Promise<void>
  refreshAllServers: () => Promise<void>

  // Per-project activation
  toggleActiveMcp: (id: string, projectId?: string | null) => void
  clearActiveMcps: (projectId?: string | null) => void
  getActiveMcpIds: (projectId?: string | null) => string[]
  getActiveMcps: (projectId?: string | null) => McpServerConfig[]
  getActiveMcpTools: (projectId?: string | null) => Record<string, McpTool[]>

  // UI
  selectedServerId: string | null
  setSelectedServer: (id: string | null) => void
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  serverStatuses: {},
  serverTools: {},
  serverResources: {},
  serverPrompts: {},
  serverErrors: {},
  activeMcpIdsByProject: {},
  selectedServerId: null,

  loadServers: async () => {
    try {
      const servers = (await ipcClient.invoke(IPC.MCP_LIST)) as McpServerConfig[]
      set({ servers: Array.isArray(servers) ? servers : [] })
    } catch {
      set({ servers: [] })
    }
  },

  addServer: async (partial) => {
    const id = nanoid()
    const config: McpServerConfig = {
      ...partial,
      id,
      createdAt: Date.now()
    }
    await ipcClient.invoke(IPC.MCP_ADD, config)
    set((s) => ({ servers: [...s.servers, config] }))
    return id
  },

  updateServer: async (id, patch) => {
    await ipcClient.invoke(IPC.MCP_UPDATE, { id, patch })
    set((s) => ({
      servers: s.servers.map((srv) => (srv.id === id ? { ...srv, ...patch } : srv))
    }))
  },

  removeServer: async (id) => {
    await ipcClient.invoke(IPC.MCP_REMOVE, id)
    set((s) => ({
      servers: s.servers.filter((srv) => srv.id !== id),
      selectedServerId: s.selectedServerId === id ? null : s.selectedServerId,
      activeMcpIdsByProject: Object.fromEntries(
        Object.entries(s.activeMcpIdsByProject).map(([projectId, ids]) => [
          projectId,
          ids.filter((mid) => mid !== id)
        ])
      )
    }))
  },

  connectServer: async (id) => {
    set((s) => ({
      serverStatuses: { ...s.serverStatuses, [id]: 'connecting' },
      serverErrors: { ...s.serverErrors, [id]: undefined }
    }))
    try {
      const res = (await ipcClient.invoke(IPC.MCP_CONNECT, id)) as {
        success: boolean
        error?: string
      }
      if (!res.success) {
        set((s) => ({
          serverStatuses: { ...s.serverStatuses, [id]: 'error' },
          serverErrors: { ...s.serverErrors, [id]: res.error }
        }))
        return res.error ?? 'Unknown error'
      }
      // Refresh info after connect
      await get().refreshServerInfo(id)
      set((s) => ({
        serverStatuses: { ...s.serverStatuses, [id]: 'connected' }
      }))
      return undefined
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set((s) => ({
        serverStatuses: { ...s.serverStatuses, [id]: 'error' },
        serverErrors: { ...s.serverErrors, [id]: msg }
      }))
      return msg
    }
  },

  disconnectServer: async (id) => {
    try {
      await ipcClient.invoke(IPC.MCP_DISCONNECT, id)
    } catch {
      // ignore
    }
    set((s) => ({
      serverStatuses: { ...s.serverStatuses, [id]: 'disconnected' },
      serverTools: { ...s.serverTools, [id]: [] },
      serverResources: { ...s.serverResources, [id]: [] },
      serverPrompts: { ...s.serverPrompts, [id]: [] },
      serverErrors: { ...s.serverErrors, [id]: undefined }
    }))
  },

  refreshServerInfo: async (id) => {
    try {
      const info = (await ipcClient.invoke(IPC.MCP_SERVER_INFO, id)) as McpServerInfo | undefined
      if (info) {
        set((s) => ({
          serverStatuses: { ...s.serverStatuses, [id]: info.status },
          serverTools: { ...s.serverTools, [id]: info.tools },
          serverResources: { ...s.serverResources, [id]: info.resources },
          serverPrompts: { ...s.serverPrompts, [id]: info.prompts },
          serverErrors: { ...s.serverErrors, [id]: info.error }
        }))
      }
    } catch {
      // ignore
    }
  },

  refreshAllServers: async () => {
    try {
      const allInfo = (await ipcClient.invoke(IPC.MCP_ALL_SERVERS_INFO)) as McpServerInfo[]
      if (!Array.isArray(allInfo)) return
      const statuses: Record<string, McpServerStatus> = {}
      const tools: Record<string, McpTool[]> = {}
      const resources: Record<string, McpResource[]> = {}
      const prompts: Record<string, McpPrompt[]> = {}
      const errors: Record<string, string | undefined> = {}
      for (const info of allInfo) {
        const id = info.config.id
        statuses[id] = info.status
        tools[id] = info.tools
        resources[id] = info.resources
        prompts[id] = info.prompts
        errors[id] = info.error
      }
      set({
        serverStatuses: statuses,
        serverTools: tools,
        serverResources: resources,
        serverPrompts: prompts,
        serverErrors: errors
      })
    } catch {
      // ignore
    }
  },

  getActiveMcpIds: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    return get().activeMcpIdsByProject[resolvedProjectId] ?? []
  },

  toggleActiveMcp: (id, projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    set((s) => {
      const currentIds = s.activeMcpIdsByProject[resolvedProjectId] ?? []
      const isActive = currentIds.includes(id)
      return {
        activeMcpIdsByProject: {
          ...s.activeMcpIdsByProject,
          [resolvedProjectId]: isActive
            ? currentIds.filter((mid) => mid !== id)
            : [...currentIds, id]
        }
      }
    })
  },

  clearActiveMcps: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    set((s) => ({
      activeMcpIdsByProject: {
        ...s.activeMcpIdsByProject,
        [resolvedProjectId]: []
      }
    }))
  },

  getActiveMcps: (projectId) => {
    const { servers } = get()
    const activeMcpIds = get().getActiveMcpIds(projectId)
    return servers.filter((s) => activeMcpIds.includes(s.id))
  },

  getActiveMcpTools: (projectId) => {
    const activeMcpIds = get().getActiveMcpIds(projectId)
    const { serverTools } = get()
    const result: Record<string, McpTool[]> = {}
    for (const id of activeMcpIds) {
      if (serverTools[id]?.length) {
        result[id] = serverTools[id]
      }
    }
    return result
  },

  setSelectedServer: (id) => set({ selectedServerId: id })
}))
