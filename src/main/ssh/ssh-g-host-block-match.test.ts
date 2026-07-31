import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('os', () => ({
  homedir: () => '/home/testuser',
  tmpdir: () => '/tmp'
}))

const mockExistsSync = vi.fn().mockReturnValue(false)
const mockReadFileSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args)
}))

const mockExecFile = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args)
}))

import { buildConnectConfig, resolveEffectiveProxy } from './ssh-connection-utils'
import type { SshTarget } from '../../shared/ssh-types'
import { resolveWithSshG, type SshResolvedConfig } from './ssh-config-parser'

const LOCAL_ACCOUNT = 'localdev'

function storedTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'target-1',
    label: 'prod',
    source: 'ssh-config',
    configHost: 'prod',
    host: '10.0.0.5',
    port: 2222,
    username: 'deploy',
    identityFile: '/keys/prod',
    jumpHost: 'bastion',
    ...overrides
  }
}

// `ssh -G prod` output when no Host block matches the alias any more.
function unmatchedDefaults(overrides: Partial<SshResolvedConfig> = {}): SshResolvedConfig {
  return {
    hostname: 'prod',
    user: LOCAL_ACCOUNT,
    port: 22,
    identityFile: [
      join('/home/testuser', '.ssh', 'id_rsa'),
      join('/home/testuser', '.ssh', 'id_ed25519')
    ],
    identitiesOnly: false,
    forwardAgent: false,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    ...overrides
  }
}

function matchedBlock(overrides: Partial<SshResolvedConfig> = {}): SshResolvedConfig {
  return unmatchedDefaults({
    hostname: '10.9.9.9',
    user: 'ops',
    port: 2200,
    identityFile: ['/keys/current-first', '/keys/current-second'],
    proxyJump: 'edge',
    ...overrides
  })
}

describe('ssh -G host-block matching', () => {
  beforeEach(() => {
    vi.stubEnv('SSH_AUTH_SOCK', '')
    vi.stubEnv('USER', LOCAL_ACCOUNT)
    vi.stubEnv('LOGNAME', LOCAL_ACCOUNT)
    vi.stubEnv('USERNAME', LOCAL_ACCOUNT)
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
    mockReadFileSync.mockImplementation((path: unknown) => Buffer.from(String(path)))
    mockExecFile.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps stored endpoint fields when the alias no longer has a Host block', () => {
    const target = storedTarget()
    const resolved = unmatchedDefaults()

    const config = buildConnectConfig(target, resolved, {
      includeAgent: false,
      includePrivateKey: true
    })

    expect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      proxy: resolveEffectiveProxy(target, resolved)
    }).toEqual({
      host: '10.0.0.5',
      port: 2222,
      username: 'deploy',
      privateKey: Buffer.from('/keys/prod'),
      proxy: { kind: 'jump-host', jumpHost: 'bastion' }
    })
  })

  it('keeps the stored ProxyCommand when the alias resolves to bare defaults', () => {
    const target = storedTarget({ jumpHost: undefined, proxyCommand: 'cf access ssh %h' })

    expect(resolveEffectiveProxy(target, unmatchedDefaults())).toEqual({
      kind: 'proxy-command',
      command: 'cf access ssh %h'
    })
  })

  it('applies fresh OpenSSH values when the Host block still matches', () => {
    const target = storedTarget()
    const resolved = matchedBlock()

    const config = buildConnectConfig(target, resolved, {
      includeAgent: false,
      includePrivateKey: true
    })

    expect(config.host).toBe('10.9.9.9')
    expect(config.port).toBe(2200)
    expect(config.username).toBe('ops')
    expect(resolveEffectiveProxy(target, resolved)).toEqual({
      kind: 'jump-host',
      jumpHost: 'edge'
    })
    // Why: #11297 — the first IdentityFile directive wins over the stored snapshot.
    expect(config.privateKey).toEqual(Buffer.from('/keys/current-first'))
    expect(mockReadFileSync).not.toHaveBeenCalledWith('/keys/prod')
  })

  // Every other field is a bare default, so only the rewritten HostName can carry the verdict.
  it('treats a rewritten HostName as a match when nothing else differs from the defaults', () => {
    const config = buildConnectConfig(
      storedTarget({ jumpHost: undefined }),
      unmatchedDefaults({ hostname: '10.9.9.9' }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.host).toBe('10.9.9.9')
  })

  it('treats a User directive as a match even when HostName echoes the alias', () => {
    const config = buildConnectConfig(
      storedTarget({ configHost: 'github.com', label: 'github.com', host: 'github.com' }),
      unmatchedDefaults({ hostname: 'github.com', user: 'git' }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.host).toBe('github.com')
    expect(config.username).toBe('git')
  })

  // Stored port stays non-22 so the legacy `target.port === 22` fallback can't supply the answer.
  it('treats a non-default Port as a match even when HostName echoes the alias', () => {
    const config = buildConnectConfig(
      storedTarget({ port: 2222 }),
      unmatchedDefaults({ port: 2022 }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.port).toBe(2022)
  })

  it('treats a ProxyJump directive as a match even when HostName echoes the alias', () => {
    const target = storedTarget({ jumpHost: 'stale-bastion' })

    expect(resolveEffectiveProxy(target, unmatchedDefaults({ proxyJump: 'edge' }))).toEqual({
      kind: 'jump-host',
      jumpHost: 'edge'
    })
  })

  it('treats a ProxyCommand directive as a match even when HostName echoes the alias', () => {
    const target = storedTarget({ jumpHost: undefined, proxyCommand: 'stale-proxy %h' })

    expect(
      resolveEffectiveProxy(target, unmatchedDefaults({ proxyCommand: 'cf access ssh %h' }))
    ).toEqual({
      kind: 'proxy-command',
      command: 'cf access ssh %h'
    })
  })

  // A launchd/systemd-spawned main process has no USER/LOGNAME/USERNAME, so the
  // resolved user proves nothing and the stored fields have to win.
  it('ignores the resolved user when the local account cannot be determined', () => {
    vi.stubEnv('USER', '')
    vi.stubEnv('LOGNAME', '')
    vi.stubEnv('USERNAME', '')

    const config = buildConnectConfig(
      storedTarget({ jumpHost: undefined }),
      unmatchedDefaults({ user: 'whoever' }),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.username).toBe('deploy')
    expect(config.host).toBe('10.0.0.5')
  })

  it('keeps manual targets on their stored fields regardless of ssh -G output', () => {
    const config = buildConnectConfig(
      storedTarget({ source: 'manual', configHost: undefined }),
      matchedBlock(),
      { includeAgent: false, includePrivateKey: true }
    )

    expect(config.host).toBe('10.0.0.5')
    expect(config.port).toBe(2222)
    expect(config.username).toBe('deploy')
  })
})

function sshGOutput(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${value}`)
    .join('\n')
}

// Serves `ssh -G <host>`; returning null makes that resolution fail.
function stubSshG(outputFor: (host: string) => string | null): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const probedHost = (args[1] as string[])[2]!
    const callback = args[3] as (err: Error | null, stdout: string) => void
    const output = outputFor(probedHost)
    if (output === null) {
      callback(new Error('ssh -G failed'), '')
    } else {
      callback(null, output)
    }
    return { kill: vi.fn() }
  })
}

// A config whose only directives live in `Host *`, so they apply to every alias.
function wildcardOnlyConfig(host: string): string {
  return sshGOutput({ host, hostname: host, user: 'ops', port: '22' })
}

describe('ssh -G differential host-block probe', () => {
  beforeEach(() => {
    vi.stubEnv('SSH_AUTH_SOCK', '')
    vi.stubEnv('USER', LOCAL_ACCOUNT)
    vi.stubEnv('LOGNAME', LOCAL_ACCOUNT)
    vi.stubEnv('USERNAME', LOCAL_ACCOUNT)
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
    mockReadFileSync.mockImplementation((path: unknown) => Buffer.from(String(path)))
    mockExecFile.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // The original P1: `Host * / User ops` makes every unmatched alias look resolved.
  it('keeps stored fields when a wildcard block is the only source of User', async () => {
    stubSshG(wildcardOnlyConfig)

    const resolved = await resolveWithSshG('prod', { hostBlockEvidence: true })
    expect(resolved?.hostBlockMatch).toBe(false)

    const config = buildConnectConfig(storedTarget(), resolved, {
      includeAgent: false,
      includePrivateKey: true
    })

    expect({
      host: config.host,
      port: config.port,
      username: config.username
    }).toEqual({
      host: '10.0.0.5',
      port: 2222,
      username: 'deploy'
    })
  })

  // `Host * / HostName %h.internal` expands against whichever alias was probed.
  it('keeps stored fields when a wildcard HostName only echoes the probed alias', async () => {
    stubSshG((host) => sshGOutput({ host, hostname: `${host}.internal`, port: '22' }))

    const resolved = await resolveWithSshG('prod', { hostBlockEvidence: true })

    expect(resolved?.hostBlockMatch).toBe(false)
    expect(
      buildConnectConfig(storedTarget(), resolved, {
        includeAgent: false,
        includePrivateKey: true
      }).host
    ).toBe('10.0.0.5')
  })

  it('applies fresh OpenSSH values when a block still names the alias', async () => {
    stubSshG((host) =>
      host === 'prod'
        ? sshGOutput({
            host,
            hostname: '10.9.9.9',
            user: 'ops',
            port: '2200',
            identityfile: '/keys/current-first'
          })
        : wildcardOnlyConfig(host)
    )

    const resolved = await resolveWithSshG('prod', { hostBlockEvidence: true })
    expect(resolved?.hostBlockMatch).toBe(true)

    const config = buildConnectConfig(storedTarget(), resolved, {
      includeAgent: false,
      includePrivateKey: true
    })

    expect({
      host: config.host,
      port: config.port,
      username: config.username
    }).toEqual({
      host: '10.9.9.9',
      port: 2200,
      username: 'ops'
    })
    // Why: #11297 — the first IdentityFile directive still wins over the stored snapshot.
    expect(config.privateKey).toEqual(Buffer.from('/keys/current-first'))
  })

  it('detects an alias-specific block that only adds an IdentityFile', async () => {
    stubSshG((host) =>
      sshGOutput(
        host === 'prod'
          ? {
              host,
              hostname: host,
              user: 'ops',
              port: '22',
              identityfile: '/keys/prod-only'
            }
          : { host, hostname: host, user: 'ops', port: '22' }
      )
    )

    expect((await resolveWithSshG('prod', { hostBlockEvidence: true }))?.hostBlockMatch).toBe(true)
  })

  it('leaves the verdict unset when the baseline probe fails', async () => {
    stubSshG((host) => (host === 'prod' ? wildcardOnlyConfig(host) : null))

    const resolved = await resolveWithSshG('prod', { hostBlockEvidence: true })

    expect(resolved?.hostBlockMatch).toBeUndefined()
    // Falls back to the effective-config heuristic, which reads `ops` as a match.
    expect(
      buildConnectConfig(storedTarget(), resolved, {
        includeAgent: false,
        includePrivateKey: true
      }).username
    ).toBe('ops')
  })

  it('skips the baseline probe when no evidence was requested', async () => {
    stubSshG(wildcardOnlyConfig)

    const resolved = await resolveWithSshG('prod')

    expect(resolved?.hostBlockMatch).toBeUndefined()
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })
})
