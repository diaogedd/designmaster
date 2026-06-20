import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { teamEvents } from '../events'
import { useTeamStore } from '../../../../stores/team-store'
import { useAgentStore } from '../../../../stores/agent-store'
import { useSettingsStore } from '../../../../stores/settings-store'
import { abortAllTeammates } from '../teammate-runner'
import { removeTeamLimiter } from '../../sub-agents/create-tool'
import { deleteTeamRuntime } from '../runtime-client'
import { stopIsolatedTeamWorkers } from '../backend-client'

export const teamDeleteTool: ToolHandler = {
  definition: {
    name: 'TeamDelete',
    description:
      'Delete the active team and clean up all resources. Use this when all tasks are completed and the team is no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async () => {
    if (!useSettingsStore.getState().teamToolsEnabled) {
      return encodeToolError('Team Tools are disabled in Settings.')
    }

    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return encodeToolError('No active team to delete')
    }

    const teamName = team.name
    const memberCount = team.members.length
    const taskCount = team.tasks.length
    const completedCount = team.tasks.filter((t) => t.status === 'completed').length

    abortAllTeammates()
    await stopIsolatedTeamWorkers({ teamName })
    useAgentStore.getState().clearPendingApprovals()
    removeTeamLimiter(teamName)

    try {
      await deleteTeamRuntime({ teamName })
      teamEvents.emit({ type: 'team_end', sessionId: team.sessionId })

      return encodeStructuredToolResult({
        success: true,
        team_name: teamName,
        members_removed: memberCount,
        tasks_total: taskCount,
        tasks_completed: completedCount
      })
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => true
}
