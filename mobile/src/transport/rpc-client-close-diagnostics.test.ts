import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'

// The [net] close/open logs are the only field diagnostic for RN transport wedges
// (msSinceLastClose classifies a redial storm; constructToCloseMs splits an RST from
// a SYN timeout). The timeout paths synthesize a close when RN omits onclose, so they
// must stamp the same state a real onclose does — and a superseded socket reporting
// its close afterwards must not restamp it over the live socket's.

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => plaintext,
  decrypt: (raw: string) => raw,
  decryptBytes: (bytes: Uint8Array) => bytes
}))

const OPEN_AFTER_MS = 100
const HANDSHAKE_TIMEOUT_MS = 5_000
const FIRST_RECONNECT_DELAY_MS = 500

type SocketPlan = {
  // Far end drops the connection on its own, delivered as a genuine onclose.
  rstAfterMs?: number
  // Delay before our own close() is reported back; omitted = never, i.e. wedged transport.
  closeReportDelayMs?: number
}

let plan: SocketPlan[] = []
const sockets: PlannedWebSocket[] = []

class PlannedWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readonly CONNECTING = 0
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  private readonly socketPlan: SocketPlan

  constructor(readonly endpoint: string) {
    this.socketPlan = plan[sockets.length] ?? plan.at(-1) ?? {}
    sockets.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, OPEN_AFTER_MS)
    if (this.socketPlan.rstAfterMs != null) {
      setTimeout(() => this.reportClosed(), this.socketPlan.rstAfterMs)
    }
  }

  // Endpoint accepts the upgrade and then never answers the handshake.
  send(): void {}

  close(): void {
    if (this.readyState === 3) {
      return
    }
    this.readyState = 3
    const reportDelayMs = this.socketPlan.closeReportDelayMs
    if (reportDelayMs == null) {
      return
    }
    setTimeout(() => this.onclose?.({ code: 1006, wasClean: false }), reportDelayMs)
  }

  private reportClosed(): void {
    if (this.readyState === 3) {
      return
    }
    this.readyState = 3
    this.onclose?.({ code: 1006, wasClean: false })
  }
}

const originalWebSocket = globalThis.WebSocket
let logs: { tag: string; fields: Record<string, unknown> }[] = []

function logged(tag: string): Record<string, unknown>[] {
  return logs.filter((entry) => entry.tag === tag).map((entry) => entry.fields)
}

describe('rpc-client close diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        logs.push({ tag: args[0], fields: args[1] as Record<string, unknown> })
      }
    })
    sockets.length = 0
    plan = [{}]
    // @ts-expect-error test double for the RN global
    globalThis.WebSocket = PlannedWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    globalThis.WebSocket = originalWebSocket
  })

  it('stamps the close time when a wedged transport never delivers onclose', () => {
    const client = connect('ws://192.168.0.56:6769', 'device-token', 'server-public-key')

    // Upgrade, then the handshake budget expires and the fallback synthesizes the close.
    vi.advanceTimersByTime(OPEN_AFTER_MS + HANDSHAKE_TIMEOUT_MS)
    expect(client.getState()).toBe('reconnecting')

    vi.advanceTimersByTime(FIRST_RECONNECT_DELAY_MS)
    expect(sockets).toHaveLength(2)

    // Without the synthesized stamp this redial reports msSinceLastClose: null,
    // hiding the redial cadence exactly when the transport is wedged.
    expect(logged('[net] openConnection').at(-1)?.msSinceLastClose).toBe(FIRST_RECONNECT_DELAY_MS)

    client.close()
  })

  it('does not restamp the close time when the real onclose lands after the synthesis', () => {
    const reportDelayMs = 200
    plan = [{ closeReportDelayMs: reportDelayMs }]
    const client = connect('ws://192.168.0.56:6769', 'device-token', 'server-public-key')

    // Synthesized close, then the OS finally reports that same close 200ms later.
    vi.advanceTimersByTime(OPEN_AFTER_MS + HANDSHAKE_TIMEOUT_MS + reportDelayMs)
    expect(logged('[net] ws.onclose')).toHaveLength(1)

    vi.advanceTimersByTime(FIRST_RECONNECT_DELAY_MS - reportDelayMs)
    expect(sockets).toHaveLength(2)

    // Measured from the synthesis, not from the duplicate report 200ms later.
    expect(logged('[net] openConnection').at(-1)?.msSinceLastClose).toBe(FIRST_RECONNECT_DELAY_MS)

    client.close()
  })

  it('keeps the live socket construct time when a superseded socket reports its close', () => {
    const rstAfterMs = 400
    // Reported late enough to land after the redial has built the replacement.
    plan = [{ closeReportDelayMs: FIRST_RECONNECT_DELAY_MS + 200 }, { rstAfterMs }]
    const client = connect('ws://192.168.0.56:6769', 'device-token', 'server-public-key')

    vi.advanceTimersByTime(OPEN_AFTER_MS + HANDSHAKE_TIMEOUT_MS + FIRST_RECONNECT_DELAY_MS + 200)
    expect(sockets).toHaveLength(2)

    // The replacement is then RST by the far end and reports a genuine close.
    vi.advanceTimersByTime(rstAfterMs)
    const closes = logged('[net] ws.onclose')
    expect(closes).toHaveLength(2)

    // The superseded socket's close used to null currentWsOpenedAt for the live
    // socket, so this reported null and the RST-vs-SYN-timeout split was lost.
    expect(closes.at(-1)?.constructToCloseMs).toBe(rstAfterMs)

    client.close()
  })
})
