import type { WindowsTerminalCapabilities } from './windows-terminal-capabilities'

// Why: an absent WSL must stay re-checkable (a distro can finish provisioning while Orca runs),
// but every re-check spawns wsl.exe/pwsh.exe on the Electron main process, so the re-check backs
// off and parks on a stable answer instead of running on a fixed interval for the app's lifetime.
const REPROBE_BASE_DELAY_MS = 30_000
const REPROBE_MAX_DELAY_MS = 5 * 60_000
/** Consecutive identical answers that count as settled; window focus re-arms afterwards. */
const REPROBE_SETTLE_STREAK = 3

type CapabilityReprobeRunner = {
  consumers: number
  timer: ReturnType<typeof globalThis.setTimeout> | null
  attempt: number
  unchangedStreak: number
  signature: string
  lastProbeAt: number
  probe: () => Promise<WindowsTerminalCapabilities>
  readCached: () => WindowsTerminalCapabilities
}

const runnersByOwnerKey = new Map<string, CapabilityReprobeRunner>()
let focusListenerAttached = false

function capabilitySignature(capabilities: WindowsTerminalCapabilities): string {
  return [
    capabilities.wslAvailable,
    capabilities.wslDistros.join('\u0000'),
    capabilities.pwshAvailable,
    capabilities.gitBashAvailable,
    capabilities.hostPlatform ?? ''
  ].join('|')
}

/** The answer #11295 waits for: a usable WSL. Nothing further to watch for. */
function isSettled(capabilities: WindowsTerminalCapabilities): boolean {
  return capabilities.wslAvailable && capabilities.wslDistros.length > 0
}

function clearRunnerTimer(runner: CapabilityReprobeRunner): void {
  if (runner.timer !== null) {
    globalThis.clearTimeout(runner.timer)
    runner.timer = null
  }
}

function scheduleNextProbe(runner: CapabilityReprobeRunner): void {
  clearRunnerTimer(runner)
  const delay = Math.min(REPROBE_BASE_DELAY_MS * 2 ** runner.attempt, REPROBE_MAX_DELAY_MS)
  runner.timer = globalThis.setTimeout(() => {
    runner.timer = null
    void runProbe(runner)
  }, delay)
}

async function runProbe(runner: CapabilityReprobeRunner): Promise<void> {
  if (runner.consumers <= 0 || isSettled(runner.readCached())) {
    return
  }
  runner.lastProbeAt = Date.now()
  const capabilities = await runner.probe().catch(() => runner.readCached())
  if (runner.consumers <= 0) {
    return
  }
  if (capabilitySignature(capabilities) === runner.signature) {
    runner.unchangedStreak += 1
    runner.attempt += 1
  } else {
    // A moving answer means the host is still changing; watch it closely again.
    runner.signature = capabilitySignature(capabilities)
    runner.unchangedStreak = 0
    runner.attempt = 0
  }
  if (isSettled(capabilities) || runner.unchangedStreak >= REPROBE_SETTLE_STREAK) {
    return
  }
  scheduleNextProbe(runner)
}

function armRunner(runner: CapabilityReprobeRunner): void {
  if (isSettled(runner.readCached())) {
    clearRunnerTimer(runner)
    return
  }
  runner.attempt = 0
  runner.unchangedStreak = 0
  scheduleNextProbe(runner)
}

// Why: re-arming restarts the ladder at the base delay, so a demand signal that arrives while a
// probe is still recent must be ignored — otherwise repeated signals pin the schedule at 30s.
function rearmOnDemandSignal(runner: CapabilityReprobeRunner): void {
  if (Date.now() - runner.lastProbeAt < REPROBE_BASE_DELAY_MS) {
    return
  }
  armRunner(runner)
}

function handleWindowFocus(): void {
  for (const runner of runnersByOwnerKey.values()) {
    rearmOnDemandSignal(runner)
  }
}

function attachFocusListener(): void {
  if (focusListenerAttached || typeof globalThis.addEventListener !== 'function') {
    return
  }
  focusListenerAttached = true
  globalThis.addEventListener('focus', handleWindowFocus)
}

function detachFocusListenerWhenIdle(): void {
  if (!focusListenerAttached || runnersByOwnerKey.size > 0) {
    return
  }
  focusListenerAttached = false
  globalThis.removeEventListener('focus', handleWindowFocus)
}

/**
 * Watch a host whose capabilities are not settled yet, and return an unregister callback.
 * Consumers of the same owner key share one backoff schedule; the last one to leave stops it.
 */
export function startWindowsTerminalCapabilityReprobe(options: {
  ownerKey: string
  probe: () => Promise<WindowsTerminalCapabilities>
  readCached: () => WindowsTerminalCapabilities
}): () => void {
  const existing = runnersByOwnerKey.get(options.ownerKey)
  const runner: CapabilityReprobeRunner = existing ?? {
    consumers: 0,
    timer: null,
    attempt: 0,
    unchangedStreak: 0,
    signature: capabilitySignature(options.readCached()),
    // Why: seed from now, or the focus guard has nothing to compare against and repeated
    // alt-tabbing right after mount re-arms every time, pushing the first probe out forever.
    lastProbeAt: Date.now(),
    probe: options.probe,
    readCached: options.readCached
  }
  runner.probe = options.probe
  runner.readCached = options.readCached
  runner.consumers += 1
  runnersByOwnerKey.set(options.ownerKey, runner)
  // A newly mounted surface is a demand signal, but joining a schedule that is already running
  // must not discard the backoff it earned — Settings opening beside a mounted status bar would
  // otherwise pin the shared owner key at a 30s spawn forever. The mount itself still reads
  // through `loadWindowsTerminalCapabilities`, so the new surface is not left waiting on this.
  if (!existing) {
    armRunner(runner)
  } else if (existing.timer === null) {
    rearmOnDemandSignal(runner)
  }
  attachFocusListener()

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    runner.consumers -= 1
    if (runner.consumers > 0) {
      return
    }
    clearRunnerTimer(runner)
    if (runnersByOwnerKey.get(options.ownerKey) === runner) {
      runnersByOwnerKey.delete(options.ownerKey)
    }
    detachFocusListenerWhenIdle()
  }
}

export function resetWindowsTerminalCapabilityReprobeForTests(): void {
  for (const runner of runnersByOwnerKey.values()) {
    clearRunnerTimer(runner)
    runner.consumers = 0
  }
  runnersByOwnerKey.clear()
  detachFocusListenerWhenIdle()
}
