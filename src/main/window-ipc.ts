import { BrowserWindow } from 'electron'

function isDisposedFrameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /render frame was disposed before webframemain could be accessed/i.test(error.message)
  )
}

export function safeSendToWindow(win: BrowserWindow, channel: string, payload: unknown): boolean {
  if (win.isDestroyed()) {
    return false
  }

  const contents = win.webContents
  if (!contents || contents.isDestroyed() || contents.isCrashed()) {
    return false
  }

  try {
    contents.send(channel, payload)
    return true
  } catch (error) {
    if (!isDisposedFrameError(error)) {
      console.warn(`[Window IPC] Failed to send ${channel}:`, error)
    }
    return false
  }
}

export function safeSendToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSendToWindow(win, channel, payload)
  }
}
