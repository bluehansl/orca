import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

export class RuntimeRpcCallError extends Error {
  readonly code: string
  readonly response: RuntimeRpcFailure

  constructor(response: RuntimeRpcFailure) {
    super(response.error.message)
    this.name = 'RuntimeRpcCallError'
    this.code = response.error.code
    this.response = response
  }
}

export function hasRuntimeRpcErrorCode(error: unknown, expectedCode: string): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (!seen.has(current)) {
    if (current instanceof Error ? current.message === expectedCode : current === expectedCode) {
      return true
    }
    if (!current || typeof current !== 'object') {
      return false
    }
    seen.add(current)
    const candidate = current as {
      cause?: unknown
      code?: unknown
      response?: { error?: { code?: unknown; message?: unknown } }
    }
    if (
      candidate.code === expectedCode ||
      candidate.response?.error?.code === expectedCode ||
      candidate.response?.error?.message === expectedCode
    ) {
      return true
    }
    current = candidate.cause
  }
  return false
}

export function unwrapRuntimeRpcResult<TResult>(response: RuntimeRpcResponse<TResult>): TResult {
  if (response.ok === false) {
    throw new RuntimeRpcCallError(response)
  }
  return response.result
}
