import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { teamEvents } from '../events'
import { createTeamRuntime } from '../runtime-client'
import { useSettingsStore } from '../../../../stores/settings-store'

export const teamCreateTool: ToolHandler = {
  definition: {
    name: 'TeamCreate',
    description:
      'Create a new agent team for parallel collaboration. Use this when a task benefits from multiple agents working simultaneously on different aspects.',
    inputSchema: {
      type: 'object',
      properties: {
        team_name: {
          type: 'string',
          description: 'Short, descriptive name for the team (e.g. "pr-review", "bug-fix-squad")'
        },
        description: {
          type: 'string',
          description: 'What this team is working on'
        },
        default_backend: {
          type: 'string',
          enum: ['in-process', 'isolated-renderer'],
          description: 'Optional default backend for teammate execution.'
        }
      },
      required: ['team_name', 'description']
    }
  },
  execute: async (input, ctx) => {
    if (!useSettingsStore.getState().teamToolsEnabled) {
      return encodeToolError('Team Tools are disabled in Settings.')
    }

    const teamName = String(input.team_name)
    const description = String(input.description)
    const defaultBackend =
      input.default_backend === 'isolated-renderer' ? 'isolated-renderer' : 'in-process'

    try {
      const runtime = await createTeamRuntime({
        teamName,
        description,
        sessionId: ctx.sessionId,
        workingFolder: ctx.workingFolder,
        defaultBackend
      })

      teamEvents.emit({
        type: 'team_start',
        sessionId: ctx.sessionId,
        teamName: runtime.teamName,
        description,
        runtimePath: runtime.runtimePath,
        leadAgentId: runtime.leadAgentId,
        defaultBackend: runtime.defaultBackend,
        permissionMode: runtime.permissionMode,
        teamAllowedPaths: runtime.teamAllowedPaths,
        createdAt: runtime.createdAt
      })

      return encodeStructuredToolResult({
        success: true,
        team_name: runtime.teamName,
        runtime_path: runtime.runtimePath,
        lead_agent_id: runtime.leadAgentId,
        default_backend: runtime.defaultBackend,
        message: `Team "${runtime.teamName}" created. Now create tasks with TaskCreate and spawn teammates with Task (run_in_background=true).`
      })
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => false
}
