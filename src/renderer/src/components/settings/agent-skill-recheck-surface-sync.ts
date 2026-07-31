import { notifyInstalledAgentSkillsRefreshed } from '@/hooks/useInstalledAgentSkills'
import { refreshSkillFreshness } from '@/hooks/useSkillFreshness'

/**
 * Publishes a completed re-check to every surface that renders its result.
 *
 * The refreshed event reuses the finished scan so siblings sync without
 * rediscovery, but it deliberately never reaches the freshness store — so a panel
 * that renders the freshness pill has to move that verdict itself, or it keeps its
 * pre-click reading forever.
 */
export function syncSurfacesAfterAgentSkillRecheck(freshnessSkillName?: string): void {
  notifyInstalledAgentSkillsRefreshed()
  if (freshnessSkillName) {
    void refreshSkillFreshness()
  }
}
