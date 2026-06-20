import { ipcMain } from 'electron'
import { DESKTOP_SCREENSHOT_CAPTURE, captureDesktopScreenshot } from './desktop-control'

export function registerScreenshotHandlers(): void {
  ipcMain.handle(DESKTOP_SCREENSHOT_CAPTURE, async () => {
    return await captureDesktopScreenshot()
  })
}
