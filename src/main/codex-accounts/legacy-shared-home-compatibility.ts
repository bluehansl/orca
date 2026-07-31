import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { syncSystemConfigIntoLegacySharedCodexHome } from '../codex/codex-config-mirror'
import { writeFileAtomically } from './fs-utils'

type LegacySharedCodexHomePaths = {
  sharedRuntimeHome: string
  systemCodexHome: string
}

export function syncLegacySharedCodexHomeForRetainedPanes(
  paths?: LegacySharedCodexHomePaths
): void {
  let resolvedPaths: LegacySharedCodexHomePaths
  try {
    resolvedPaths = paths ?? {
      sharedRuntimeHome: getOrcaManagedCodexHomePath(),
      systemCodexHome: getSystemCodexHomePath()
    }
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to resolve legacy shared home:', error)
    return
  }
  runCompatibilitySync('auth', () => syncSystemAuthIntoLegacySharedHome(resolvedPaths))
  runCompatibilitySync('config', () =>
    syncSystemConfigIntoLegacySharedCodexHome({
      runtimeHomePath: resolvedPaths.sharedRuntimeHome,
      systemHomePath: resolvedPaths.systemCodexHome
    })
  )
}

function syncSystemAuthIntoLegacySharedHome(paths: LegacySharedCodexHomePaths): void {
  const systemAuthPath = join(paths.systemCodexHome, 'auth.json')
  const sharedAuthPath = join(paths.sharedRuntimeHome, 'auth.json')
  if (!existsSync(systemAuthPath)) {
    rmSync(sharedAuthPath, { force: true })
    return
  }

  const systemAuth = readFileSync(systemAuthPath, 'utf-8')
  mkdirSync(paths.sharedRuntimeHome, { recursive: true })
  if (existsSync(sharedAuthPath) && readFileSync(sharedAuthPath, 'utf-8') === systemAuth) {
    chmodSync(sharedAuthPath, 0o600)
    return
  }
  writeFileAtomically(sharedAuthPath, systemAuth, { mode: 0o600 })
}

function runCompatibilitySync(resource: 'auth' | 'config', sync: () => void): void {
  try {
    sync()
  } catch (error) {
    // Why: compatibility for a retained pane must never block real-home Codex.
    console.warn(`[codex-runtime-home] Failed to refresh legacy shared ${resource}:`, error)
  }
}
