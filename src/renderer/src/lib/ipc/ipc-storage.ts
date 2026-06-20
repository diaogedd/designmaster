import type { StateStorage } from 'zustand/middleware'
import { ipcClient } from './ipc-client'

/**
 * Custom Zustand StateStorage that delegates to main process settings.json
 * via IPC, replacing localStorage.
 */
export const ipcStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const value = await ipcClient.invoke('settings:get', name)
      if (value === undefined || value === null) return null
      return typeof value === 'string' ? value : JSON.stringify(value)
    } catch {
      return null
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    try {
      // Store as parsed JSON so the file stays human-readable
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        parsed = value
      }
      await ipcClient.invoke('settings:set', { key: name, value: parsed })
    } catch {
      // Silently fail — main process logs the error
    }
  },

  removeItem: async (name: string): Promise<void> => {
    try {
      await ipcClient.invoke('settings:set', { key: name, value: undefined })
    } catch {
      // Silently fail
    }
  }
}
