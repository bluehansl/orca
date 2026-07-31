import { execFile, execFileSync } from 'node:child_process'

const PWSH_SYNC_PROBE_TIMEOUT_MS = 5000
const PWSH_WARMUP_PROBE_TIMEOUT_MS = 30_000
const PWSH_NEGATIVE_CACHE_TTL_MS = 30_000

type PwshAvailabilityCache =
  | { available: true }
  | { available: false; cachedAt: number; retryable: boolean }

let pwshAvailableCache: PwshAvailabilityCache | null = null
let pwshWarmupInFlight: Promise<boolean> | null = null
let pwshProbeInFlight: Promise<boolean> | null = null
// Why: the sync probe, the async twin and the warm-up can all be outstanding at once (the sync
// one cannot await the others). Every write bumps this so a slower, older probe cannot clobber a
// newer answer — a 30s "missing" cached over a success is what disables the user's PowerShell 7.
let pwshCacheGeneration = 0

function setPwshAvailabilityCache(next: PwshAvailabilityCache | null): void {
  pwshAvailableCache = next
  pwshCacheGeneration += 1
}

function isCacheFresh(cache: PwshAvailabilityCache): boolean {
  return (
    cache.available || !cache.retryable || Date.now() - cache.cachedAt < PWSH_NEGATIVE_CACHE_TTL_MS
  )
}

// Why: execFileSync reports a timeout as ETIMEDOUT, but the execFile callback reports it as a
// SIGTERM kill with no code — both shapes must be recognised or the async probe caches a
// cold-start timeout as "pwsh missing".
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown }
  return failure.code === 'ETIMEDOUT' || (failure.killed === true && failure.signal === 'SIGTERM')
}

function cachePwshProbeFailure(error: unknown, generation: number): void {
  // A probe that started before the current answer was written is stale; drop its failure.
  if (generation !== pwshCacheGeneration) {
    return
  }
  // Why: pwsh.exe cold starts can exceed the sync timeout; do not let one slow
  // .NET startup disable the user's PowerShell 7 preference for the daemon.
  if (isTimeoutError(error)) {
    setPwshAvailabilityCache(null)
    return
  }
  setPwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: true })
}

/**
 * Check whether pwsh.exe is available on this Windows machine.
 * Positive results are cached for the process lifetime; negative results are
 * retried so transient cold-start failures cannot outlive the daemon.
 */
export function isPwshAvailable(): boolean {
  if (pwshAvailableCache && isCacheFresh(pwshAvailableCache)) {
    return pwshAvailableCache.available
  }

  if (process.platform !== 'win32') {
    setPwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: false })
    return false
  }

  const generation = pwshCacheGeneration
  try {
    execFileSync('pwsh.exe', ['-Version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PWSH_SYNC_PROBE_TIMEOUT_MS
    })
    setPwshAvailabilityCache({ available: true })
  } catch (error) {
    cachePwshProbeFailure(error, generation)
  }

  return pwshAvailableCache?.available ?? false
}

/**
 * Async twin of `isPwshAvailable`, sharing its cache.
 *
 * Why: the renderer's capability read reaches this over IPC, and the sync probe blocks the
 * Electron main thread for up to 5s when pwsh.exe cold-starts. Concurrent callers share one spawn.
 */
export function isPwshAvailableAsync(): Promise<boolean> {
  if (pwshAvailableCache && isCacheFresh(pwshAvailableCache)) {
    return Promise.resolve(pwshAvailableCache.available)
  }

  if (process.platform !== 'win32') {
    setPwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: false })
    return Promise.resolve(false)
  }

  if (pwshProbeInFlight) {
    return pwshProbeInFlight
  }

  const generation = pwshCacheGeneration
  pwshProbeInFlight = new Promise((resolve) => {
    execFile('pwsh.exe', ['-Version'], { timeout: PWSH_SYNC_PROBE_TIMEOUT_MS }, (error) => {
      pwshProbeInFlight = null
      if (error) {
        cachePwshProbeFailure(error, generation)
      } else {
        setPwshAvailabilityCache({ available: true })
      }
      resolve(pwshAvailableCache?.available ?? false)
    })
  })
  return pwshProbeInFlight
}

export function warmPwshAvailabilityCache(): Promise<boolean> {
  if (pwshAvailableCache?.available) {
    return Promise.resolve(true)
  }
  if (process.platform !== 'win32') {
    setPwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: false })
    return Promise.resolve(false)
  }
  if (pwshWarmupInFlight) {
    return pwshWarmupInFlight
  }

  const generation = pwshCacheGeneration
  pwshWarmupInFlight = new Promise((resolve) => {
    execFile('pwsh.exe', ['-Version'], { timeout: PWSH_WARMUP_PROBE_TIMEOUT_MS }, (error) => {
      pwshWarmupInFlight = null
      if (!error) {
        setPwshAvailabilityCache({ available: true })
        resolve(true)
        return
      }
      cachePwshProbeFailure(error, generation)
      resolve(false)
    })
  })
  return pwshWarmupInFlight
}
