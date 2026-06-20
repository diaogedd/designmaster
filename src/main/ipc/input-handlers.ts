import { ipcMain } from 'electron'
import {
  DESKTOP_INPUT_CLICK,
  DESKTOP_INPUT_SCROLL,
  DESKTOP_INPUT_TYPE,
  desktopInputClick,
  desktopInputScroll,
  desktopInputType,
  type ClickArgs,
  type ScrollArgs,
  type TypeArgs
} from './desktop-control'

export function registerInputHandlers(): void {
  ipcMain.handle(DESKTOP_INPUT_CLICK, (_event, args: ClickArgs) => {
    return desktopInputClick(args)
  })

  ipcMain.handle(DESKTOP_INPUT_TYPE, (_event, args: TypeArgs) => {
    return desktopInputType(args)
  })

  ipcMain.handle(DESKTOP_INPUT_SCROLL, (_event, args: ScrollArgs) => {
    return desktopInputScroll(args)
  })
}
