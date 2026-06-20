import type {
  SpawnIsolatedTeamWorkerArgs,
  SpawnIsolatedTeamWorkerResult,
  StopIsolatedTeamWorkerArgs,
  StopIsolatedTeamWorkersArgs
} from '../../../../../shared/team-runtime-types'

export async function spawnIsolatedTeamWorker(
  args: SpawnIsolatedTeamWorkerArgs
): Promise<SpawnIsolatedTeamWorkerResult> {
  return window.api.teamWorkerSpawn(args)
}

export async function stopIsolatedTeamWorker(
  args: StopIsolatedTeamWorkerArgs
): Promise<{ success: true }> {
  return window.api.teamWorkerStop(args)
}

export async function stopIsolatedTeamWorkers(
  args: StopIsolatedTeamWorkersArgs
): Promise<{ success: true }> {
  return window.api.teamWorkerStopTeam(args)
}
