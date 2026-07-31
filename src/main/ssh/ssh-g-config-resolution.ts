import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'

export type SshResolvedConfig = {
  hostname: string
  user?: string
  port: number
  identityFile: string[]
  identityAgent?: string
  identitiesOnly: boolean
  forwardAgent: boolean
  /** Effective GSSAPIAuthentication, including distro-wide /etc/ssh defaults. */
  gssapiAuthentication?: boolean
  proxyCommand?: string
  proxyUseFdpass: boolean
  proxyJump?: string
  controlMaster: string
  controlPath?: string
  controlPersist: string
  /**
   * Whether a Host/Match block that names this alias actually applied, proven by
   * diffing the resolution against an alias no config can name. Undefined when
   * the caller did not ask for the probe or the probe could not run.
   */
  hostBlockMatch?: boolean
}

export type SshGResolveOptions = {
  /** Also resolve an unmatchable alias so wildcard/global directives can be told apart from alias-specific ones. */
  hostBlockEvidence?: boolean
}

const SSH_G_TIMEOUT_MS = 5000

/**
 * Resolve `ssh -G <host>`, optionally with differential evidence about whether
 * an alias-specific Host/Match block applied.
 *
 * Why: `ssh -G` exits 0 for an alias with no matching block and still prints a
 * fully populated config, so the effective values alone cannot say whether they
 * came from the alias's own block or from `Host *`/`/etc/ssh/ssh_config`. A
 * second resolution of an alias nothing can name isolates the global part:
 * whatever differs between the two came from a block that named this alias.
 */
export async function resolveWithSshG(
  host: string,
  options?: SshGResolveOptions
): Promise<SshResolvedConfig | null> {
  if (options?.hostBlockEvidence !== true) {
    return runSshG(host)
  }
  const probeHost = createUnmatchableProbeHost()
  const [resolved, baseline] = await Promise.all([runSshG(host), runSshG(probeHost)])
  if (!resolved || !baseline) {
    // Why: with no baseline the diff proves nothing, so leave the verdict unset
    // and let callers fall back to their effective-config heuristics.
    return resolved
  }
  return {
    ...resolved,
    hostBlockMatch: hostBlockSignature(resolved, host) !== hostBlockSignature(baseline, probeHost)
  }
}

// Why: the probe alias must be unnameable by a real block, so keep it random and
// free of `.`/`-` so `Host *.corp` or `Host prod-*` cannot single it out; a bare
// `Host *` still matches it, which is exactly what has to cancel out.
function createUnmatchableProbeHost(): string {
  return randomBytes(16).toString('hex')
}

// Why: only fields Orca actually applies to a connection are compared; a block
// that differs solely in ControlMaster plumbing should not override stored state.
function hostBlockSignature(config: SshResolvedConfig, probedHost: string): string {
  const mask = (value: string | undefined): string | undefined => maskProbedHost(value, probedHost)
  return JSON.stringify([
    mask(config.hostname),
    mask(config.user),
    config.port,
    config.identityFile.map((identityFile) => mask(identityFile)),
    mask(config.identityAgent),
    config.identitiesOnly,
    config.forwardAgent,
    config.gssapiAuthentication,
    mask(config.proxyCommand),
    mask(config.proxyJump),
    config.proxyUseFdpass
  ])
}

// Why: `ssh -G` echoes the probed alias back as hostname and expands %h/%n into
// wildcard values, so those occurrences differ by construction and must be
// blanked out before the two resolutions can be compared.
function maskProbedHost(value: string | undefined, probedHost: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const lowered = value.toLowerCase()
  const token = probedHost.trim().toLowerCase()
  if (!token) {
    return lowered
  }
  return lowered.replace(
    new RegExp(`(?<![a-z0-9_])${escapeRegExpLiteral(token)}(?![a-z0-9_])`, 'g'),
    '\u0000'
  )
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runSshG(host: string): Promise<SshResolvedConfig | null> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      resolve(null)
    }, SSH_G_TIMEOUT_MS)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    // Why: '--' prevents host labels starting with '-' from becoming SSH flags.
    // execFile's timeout only signals ssh; keep the null fallback for stuck callbacks.
    try {
      child = execFile('ssh', ['-G', '--', host], { timeout: SSH_G_TIMEOUT_MS }, (err, stdout) => {
        if (err) {
          settle(() => resolve(null))
          return
        }
        settle(() => resolve(parseSshGOutput(stdout)))
      })
    } catch {
      settle(() => resolve(null))
    }
  })
}

export function parseSshGOutput(stdout: string): SshResolvedConfig {
  const map = new Map<string, string>()
  const identityFiles: string[] = []

  for (const line of stdout.split('\n')) {
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx === -1) {
      continue
    }
    const key = line.substring(0, spaceIdx).toLowerCase()
    const value = line.substring(spaceIdx + 1).trim()
    if (key === 'identityfile') {
      identityFiles.push(resolveSshConfigHomePath(value))
    } else {
      map.set(key, value)
    }
  }

  return buildSshResolvedConfig(map, identityFiles)
}

function buildSshResolvedConfig(
  map: Map<string, string>,
  identityFiles: string[]
): SshResolvedConfig {
  // Why: `ssh -G` outputs `proxycommand none` / `proxyjump none` when no
  // proxy is configured. Treating "none" as real would spawn bad commands.
  const rawProxy = map.get('proxycommand')
  const proxyCommand = rawProxy && rawProxy !== 'none' ? rawProxy : undefined
  const rawJump = map.get('proxyjump')
  const proxyJump = rawJump && rawJump !== 'none' ? rawJump : undefined
  const rawIdentityAgent = map.get('identityagent')
  const identityAgent = rawIdentityAgent ? resolveSshConfigHomePath(rawIdentityAgent) : undefined
  const rawControlPath = map.get('controlpath')
  const controlPath =
    rawControlPath && rawControlPath !== 'none'
      ? resolveSshConfigHomePath(rawControlPath)
      : undefined

  return {
    hostname: map.get('hostname') ?? '',
    user: map.get('user') || undefined,
    port: Number.parseInt(map.get('port') ?? '22', 10),
    identityFile: identityFiles,
    identityAgent,
    identitiesOnly: map.get('identitiesonly') === 'yes',
    forwardAgent: map.get('forwardagent') === 'yes',
    gssapiAuthentication: map.get('gssapiauthentication') === 'yes',
    proxyCommand,
    proxyUseFdpass: map.get('proxyusefdpass') === 'yes',
    proxyJump,
    controlMaster: map.get('controlmaster') ?? 'no',
    controlPath,
    controlPersist: map.get('controlpersist') ?? 'no'
  }
}
