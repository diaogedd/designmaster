import type { StateStorage } from 'zustand/middleware'
import { ipcClient } from './ipc-client'

/**
 * Custom Zustand StateStorage that delegates to ~/.open-cowork/config.json
 * via IPC. Used for provider configurations including API keys.
 */
export const configStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const value = await ipcClient.invoke('config:get', name)
      if (value === undefined || value === null) return null
      return typeof value === 'string' ? value : JSON.stringify(value)
    } catch {
      return null
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        parsed = value
      }
      await ipcClient.invoke('config:set', { key: name, value: parsed })
    } catch {
      // Silently fail — main process logs the error
    }
  },

  removeItem: async (name: string): Promise<void> => {
    try {
      await ipcClient.invoke('config:set', { key: name, value: undefined })
    } catch {
      // Silently fail
    }
  }
}
