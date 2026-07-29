import { beforeEach, describe, expect, it, vi } from 'vitest'

const unregisterPtyDataHandlers = vi.hoisted(() => vi.fn(() => []))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers
}))

const runtimeCall = vi.fn()
const killPty = vi.fn().mockResolvedValue(undefined)

globalThis.window = {
  api: {
    pty: { kill: killPty },
    runtimeEnvironments: { call: runtimeCall }
  }
} as never

import { getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeRuntimeOwnedWorktree, makeTab, seedStore } from './store-test-helpers'

describe('worktree terminal removal teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retires renderer bindings without stopping the already-removed remote workspace again', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/srv/worktree'
    const ptyId = 'remote:env-1@@pty-1'
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' },
      worktreesByRepo: {
        repo1: [
          makeRuntimeOwnedWorktree(
            { id: worktreeId, repoId: 'repo1', path: '/srv/worktree' },
            'env-1'
          )
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId })]
      },
      ptyIdsByTabId: { 'tab-1': [ptyId] }
    })

    await store
      .getState()
      .shutdownWorktreeTerminals(worktreeId, { shutdownReason: 'remove-worktree' })

    expect(runtimeCall).not.toHaveBeenCalled()
    expect(killPty).not.toHaveBeenCalled()
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(store.getState().pendingPtyShutdownIds[ptyId]).toBeUndefined()
  })
})
