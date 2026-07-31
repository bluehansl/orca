import { execFile, execFileSync } from 'node:child_process'

type WslAvailabilityCache =
  | { available: true }
  /** Not Windows — never re-probed. */
  | { available: false; unsupported: true }
  | { available: false; cachedAt: number; retryable: boolean; failures: number }

let wslAvailableCache: WslAvailabilityCache | null = null
let wslAvailabilityProbeInFlight: Promise<boolean> | null = null
// Why: probes can overlap — the sync twin cannot await the async one, and a distro list can
// prove wsl.exe runs mid-probe. Every write bumps this, so a probe that started earlier never
// resurrects an answer a newer write already superseded.
let wslAvailabilityCacheGeneration = 0

function setWslAvailabilityCache(next: WslAvailabilityCache | null): void {
  wslAvailableCache = next
  wslAvailabilityCacheGeneration += 1
}

const WSL_AVAILABILITY_PROBE_TIMEOUT_MS = 5000
// Why: availability is a separate, blocking probe. Deliberately not a multiple of the
// renderer's 30s capability TTL, so repeated refreshes don't land on this boundary and
// re-probe every cycle.
const WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS = 45_000
// Why: even a definitive-looking non-zero exit can be transient — wsl.exe reports one
// while the WSL package is servicing or LxssManager is still starting — so nothing
// latches for the whole session; it just waits much longer before paying the probe again.
const WSL_AVAILABILITY_DEFINITIVE_TTL_MS = 10 * 60_000
const WSL_AVAILABILITY_MAX_RETRY_DELAY_MS = 30 * 60_000

function isPermanentWslAvailabilityCache(cache: WslAvailabilityCache): boolean {
  // Why: re-check the platform so a cache seeded off-Windows can't suppress a real probe.
  return cache.available || ('unsupported' in cache && process.platform !== 'win32')
}

// Why: the probe spawns wsl.exe, so a host with a wedged wsl.exe must not pay it every
// window; back off per consecutive failure.
function wslAvailabilityRetryDelayMs(cache: { retryable: boolean; failures: number }): number {
  const base = cache.retryable
    ? WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS
    : WSL_AVAILABILITY_DEFINITIVE_TTL_MS
  return Math.min(base * 2 ** (cache.failures - 1), WSL_AVAILABILITY_MAX_RETRY_DELAY_MS)
}

// Why: a non-zero exit (wsl.exe ran and said no) or ENOENT (not installed) is answer-shaped,
// so it earns a long window rather than the short one a timeout gets. execFileSync reports the
// exit code as `status`, the execFile callback as a numeric `code`; both must count as
// definitive or the async twin poisons the shared cache with the short retryable window.
// Same numeric-status rule as `wslUncDirectoryExists`; neither latches forever.
function isRetryableWslProbeFailure(error: unknown): boolean {
  const failure = error as { status?: unknown; code?: unknown } | null
  if (typeof failure?.status === 'number' || typeof failure?.code === 'number') {
    return false
  }
  return failure?.code !== 'ENOENT'
}

function isWslAvailabilityCacheFresh(cache: WslAvailabilityCache): boolean {
  if (isPermanentWslAvailabilityCache(cache)) {
    return true
  }
  if (!('cachedAt' in cache)) {
    return false
  }
  return Date.now() - cache.cachedAt < wslAvailabilityRetryDelayMs(cache)
}

function reusableWslAvailability(): boolean | null {
  return wslAvailableCache && isWslAvailabilityCacheFresh(wslAvailableCache)
    ? wslAvailableCache.available
    : null
}

function previousWslAvailabilityFailures(): number {
  return wslAvailableCache && 'failures' in wslAvailableCache ? wslAvailableCache.failures : 0
}

function cacheWslAvailabilityProbeResult(error: unknown, generation: number): boolean {
  if (!error) {
    // A zero exit is proof, and #11295 says absent must never latch, so a success always wins.
    setWslAvailabilityCache({ available: true })
    return true
  }
  // Why: a newer probe answered, or a non-empty distro list proved wsl.exe runs, while this one
  // was in flight. Its failure is stale: writing it would restore a negative cache — with a
  // failure count and backoff window built on state that no longer holds.
  if (generation !== wslAvailabilityCacheGeneration) {
    return wslAvailableCache?.available ?? false
  }
  setWslAvailabilityCache({
    available: false,
    cachedAt: Date.now(),
    retryable: isRetryableWslProbeFailure(error),
    failures: previousWslAvailabilityFailures() + 1
  })
  return false
}

function probeWslStatus(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['--status'],
      { timeout: WSL_AVAILABILITY_PROBE_TIMEOUT_MS },
      (error: unknown) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      }
    )
  })
}

/**
 * Check whether wsl.exe is available and functional on this Windows machine.
 * Success caches for the process lifetime; every failure is re-probed eventually, so
 * a slow wsl.exe activation on a just-installed or just-rebooted machine cannot latch
 * WSL off for the whole session.
 */
export function isWslAvailable(): boolean {
  const cached = reusableWslAvailability()
  if (cached !== null) {
    return cached
  }

  if (process.platform !== 'win32') {
    setWslAvailabilityCache({ available: false, unsupported: true })
    return false
  }

  const generation = wslAvailabilityCacheGeneration
  try {
    execFileSync('wsl.exe', ['--status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: WSL_AVAILABILITY_PROBE_TIMEOUT_MS
    })
    return cacheWslAvailabilityProbeResult(null, generation)
  } catch (error) {
    return cacheWslAvailabilityProbeResult(error, generation)
  }
}

/**
 * Async twin of `isWslAvailable`, sharing its cache and backoff.
 *
 * Why: the renderer's capability read reaches this over IPC, and the sync probe blocks the
 * Electron main thread — every PTY message, window IPC and watchdog beat — for up to 5s on a
 * wedged wsl.exe. Concurrent async callers share one spawn; prefer this over the sync twin.
 */
export function isWslAvailableAsync(): Promise<boolean> {
  const cached = reusableWslAvailability()
  if (cached !== null) {
    return Promise.resolve(cached)
  }

  if (process.platform !== 'win32') {
    setWslAvailabilityCache({ available: false, unsupported: true })
    return Promise.resolve(false)
  }

  if (wslAvailabilityProbeInFlight) {
    return wslAvailabilityProbeInFlight
  }

  const generation = wslAvailabilityCacheGeneration
  wslAvailabilityProbeInFlight = probeWslStatus()
    .then(() => cacheWslAvailabilityProbeResult(null, generation))
    .catch((error: unknown) => cacheWslAvailabilityProbeResult(error, generation))
    .finally(() => {
      wslAvailabilityProbeInFlight = null
    })
  return wslAvailabilityProbeInFlight
}

export function hasCachedWslAvailability(): boolean {
  return wslAvailableCache !== null
}

// Why: same contract as the distro getter — report the last observed answer. Going
// null on staleness would drop the `wsl-unavailable` repair prompt and let git and
// PTY silently resolve to a WSL that last failed to respond. `isWslAvailable` is what
// clears it, by re-probing once the retry window lapses.
export function getCachedWslAvailability(): boolean | null {
  return wslAvailableCache?.available ?? null
}

// Why: the two caches expire independently, and `getWslRepairReason` checks availability
// first — so a definitive failure held for 10-30min would report `wsl-unavailable` over a
// WSL that just listed a distro for us. A non-empty list proves wsl.exe ran, so drop the
// stale failure and let the next call re-probe. Non-empty lists are cached for the process
// lifetime, so this cannot re-spawn the blocking probe more than once.
export function dropStaleWslAvailabilityFailure(): void {
  // Why: the bump is unconditional — a probe already in flight must not land its failure
  // afterwards either, or the window the distro list just disproved comes back anyway.
  wslAvailabilityCacheGeneration += 1
  if (wslAvailableCache && !wslAvailableCache.available && !('unsupported' in wslAvailableCache)) {
    wslAvailableCache = null
  }
}

export function _resetWslAvailabilityCacheForTests(): void {
  setWslAvailabilityCache(null)
  wslAvailabilityProbeInFlight = null
}

export function _setWslAvailabilityCacheForTests(
  available: boolean | null | undefined,
  retryable: boolean
): void {
  setWslAvailabilityCache(
    available === true
      ? { available: true }
      : available === false
        ? { available: false, cachedAt: Date.now(), retryable, failures: 1 }
        : null
  )
}
