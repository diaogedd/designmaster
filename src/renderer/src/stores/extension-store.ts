import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ExtensionInstance } from '../../../shared/extension-types'

interface ExtensionStore {
  extensions: ExtensionInstance[]
  loaded: boolean
  loadExtensions: () => Promise<void>
  installFromFolder: (sourcePath: string) => Promise<{ success: boolean; error?: string }>
  updateExtension: (
    id: string,
    patch: { enabled?: boolean; config?: Record<string, string> }
  ) => Promise<{ success: boolean; error?: string }>
  removeExtension: (id: string) => Promise<{ success: boolean; error?: string }>
  openExtensionFolder: (id: string) => Promise<{ success: boolean; error?: string }>
}

function normalizeExtensions(value: unknown): ExtensionInstance[] {
  return Array.isArray(value) ? (value as ExtensionInstance[]) : []
}

export const useExtensionStore = create<ExtensionStore>((set, get) => ({
  extensions: [],
  loaded: false,

  loadExtensions: async () => {
    try {
      const result = await ipcClient.invoke(IPC.EXTENSION_LIST)
      set({ extensions: normalizeExtensions(result), loaded: true })
    } catch (err) {
      console.error('[Extensions] Failed to load extensions:', err)
      set({ extensions: [], loaded: true })
    }
  },

  installFromFolder: async (sourcePath) => {
    const result = (await ipcClient.invoke(IPC.EXTENSION_INSTALL_FROM_FOLDER, {
      sourcePath
    })) as { success: boolean; error?: string }
    await get().loadExtensions()
    return result
  },

  updateExtension: async (id, patch) => {
    const result = (await ipcClient.invoke(IPC.EXTENSION_UPDATE, {
      id,
      patch
    })) as { success: boolean; error?: string }
    await get().loadExtensions()
    return result
  },

  removeExtension: async (id) => {
    const result = (await ipcClient.invoke(IPC.EXTENSION_REMOVE, id)) as {
      success: boolean
      error?: string
    }
    await get().loadExtensions()
    return result
  },

  openExtensionFolder: async (id) => {
    return (await ipcClient.invoke(IPC.EXTENSION_OPEN_FOLDER, id)) as {
      success: boolean
      error?: string
    }
  }
}))

export async function initExtensionStore(): Promise<void> {
  await useExtensionStore.getState().loadExtensions()
}
