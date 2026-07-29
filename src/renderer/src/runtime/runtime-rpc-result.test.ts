import { describe, expect, it } from 'vitest'
import { hasRuntimeRpcErrorCode, RuntimeRpcCallError } from './runtime-rpc-result'

describe('hasRuntimeRpcErrorCode', () => {
  it('matches structured runtime failures through wrapped causes', () => {
    const failure = new RuntimeRpcCallError({
      id: 'rpc-1',
      ok: false,
      error: { code: 'selector_not_found', message: 'Selector not found' }
    })

    expect(
      hasRuntimeRpcErrorCode(new Error('remove failed', { cause: failure }), failure.code)
    ).toBe(true)
  })

  it('supports legacy response envelopes and exact plain errors', () => {
    expect(
      hasRuntimeRpcErrorCode(
        { response: { error: { message: 'repo_not_found' } } },
        'repo_not_found'
      )
    ).toBe(true)
    expect(hasRuntimeRpcErrorCode('repo_not_found', 'repo_not_found')).toBe(true)
  })

  it('rejects diagnostic mentions and cyclic causes', () => {
    const cycle: { cause?: unknown; message: string } = { message: 'permission_denied' }
    cycle.cause = cycle

    expect(
      hasRuntimeRpcErrorCode(
        new Error('Access denied after a prior selector_not_found diagnostic'),
        'selector_not_found'
      )
    ).toBe(false)
    expect(hasRuntimeRpcErrorCode(cycle, 'selector_not_found')).toBe(false)
  })
})
