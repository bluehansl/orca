import type { AgentTeam, AgentTeamsTerminalApi, TeamPane } from './claude-agent-teams-types'

function isStaleTerminalHandleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('terminal_handle_stale') || message.includes('terminal_gone')
}

// Why: teams outlive remintable terminal handles (the leader handle is snapshotted at
// launch), so recover a stale handle via the pane key and retry once instead of
// failing every teammate operation for the rest of the session.
export async function withFreshPaneHandle<T>(
  team: AgentTeam,
  pane: TeamPane,
  api: AgentTeamsTerminalApi,
  operation: (handle: string) => Promise<T>
): Promise<T> {
  try {
    return await operation(pane.handle)
  } catch (error) {
    if (!isStaleTerminalHandleError(error) || !pane.paneKey) {
      throw error
    }
    const fresh = api.resolveTerminalHandleForPaneKey?.(pane.paneKey)
    if (!fresh || fresh === pane.handle) {
      throw error
    }
    pane.handle = fresh
    if (pane.fakePaneId === team.leaderPane) {
      team.leaderHandle = fresh
    }
    return await operation(fresh)
  }
}
