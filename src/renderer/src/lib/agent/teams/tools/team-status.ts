import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { useTeamStore } from '../../../../stores/team-store'
import { useSettingsStore } from '../../../../stores/settings-store'
import { getTeamRuntimeSnapshot } from '../runtime-client'

/**
 * TeamStatus — non-blocking snapshot of the current team state.
 * Returns members, tasks, and recent messages without waiting.
 * Use this to check progress without waiting.
 */
export const teamStatusTool: ToolHandler = {
  definition: {
    name: 'TeamStatus',
    description:
      'Get a snapshot of the current team state: all members with their status, all tasks, and recent messages. Non-blocking — returns immediately. Use this to check progress without waiting.',
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

    const teamStore = useTeamStore.getState()
    const team = teamStore.activeTeam
    if (!team) {
      return encodeToolError('No active team')
    }

    const snapshot = await getTeamRuntimeSnapshot({ teamName: team.name, limit: 10 })
    if (snapshot) {
      teamStore.syncRuntimeSnapshot(snapshot, team.sessionId)
    }

    const currentTeam = useTeamStore.getState().activeTeam
    if (!currentTeam) {
      return encodeToolError('No active team')
    }

    const completedTasks = currentTeam.tasks.filter((t) => t.status === 'completed').length
    const workingMembers = currentTeam.members.filter((m) => m.status === 'working').length

    return encodeStructuredToolResult({
      team_name: currentTeam.name,
      description: currentTeam.description,
      runtime_path: currentTeam.runtimePath,
      lead_agent_id: currentTeam.leadAgentId,
      default_backend: currentTeam.defaultBackend,
      permission_mode: currentTeam.permissionMode,
      team_allowed_paths: currentTeam.teamAllowedPaths ?? [],
      summary: `${currentTeam.members.length} members (${workingMembers} working), ${completedTasks}/${currentTeam.tasks.length} tasks completed`,
      members: currentTeam.members.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        backend_type: m.backendType,
        status: m.status,
        model: m.model,
        current_task_id: m.currentTaskId,
        iteration: m.iteration,
        tool_calls_count: m.toolCalls.length,
        started_at: m.startedAt,
        completed_at: m.completedAt
      })),
      tasks: currentTeam.tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        depends_on: t.dependsOn
      })),
      recent_messages: currentTeam.messages.slice(-10).map((msg) => ({
        from: msg.from,
        to: msg.to,
        type: msg.type,
        content: msg.content,
        summary: msg.summary
      }))
    })
  },
  requiresApproval: () => false
}
