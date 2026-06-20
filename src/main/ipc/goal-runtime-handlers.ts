import { ipcMain } from 'electron'
import { getGoalRuntimeService } from '../goals/goal-runtime'

export function registerGoalRuntimeHandlers(): void {
  ipcMain.handle(
    'goal-runtime:can-mark-blocked',
    (_event, args: { sessionId?: string; goalId?: string | null }) => {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
      if (!sessionId) return { canMarkBlocked: false }
      const goalId = typeof args?.goalId === 'string' ? args.goalId.trim() : null
      return {
        canMarkBlocked: getGoalRuntimeService().canMarkGoalBlocked(sessionId, goalId)
      }
    }
  )
}
