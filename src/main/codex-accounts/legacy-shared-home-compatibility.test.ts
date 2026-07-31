import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncLegacySharedCodexHomeForRetainedPanes } from './legacy-shared-home-compatibility'

let root: string
let sharedRuntimeHome: string
let systemCodexHome: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-legacy-codex-home-'))
  sharedRuntimeHome = join(root, 'codex-runtime-home', 'home')
  systemCodexHome = join(root, 'system-home', '.codex')
  mkdirSync(sharedRuntimeHome, { recursive: true })
  mkdirSync(systemCodexHome, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('legacy shared Codex home compatibility', () => {
  it('refreshes retained panes with the authenticated production provider', () => {
    const systemAuth = '{"tokens":{"access_token":"system"}}\n'
    const systemConfig = [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "https://codex-lb.example.test/v1"',
      'requires_openai_auth = true',
      ''
    ].join('\n')
    writeFileSync(join(systemCodexHome, 'auth.json'), systemAuth, 'utf-8')
    writeFileSync(join(systemCodexHome, 'config.toml'), systemConfig, 'utf-8')
    writeFileSync(join(sharedRuntimeHome, 'auth.json'), '{"tokens":{"access_token":"stale"}}\n')
    writeFileSync(
      join(sharedRuntimeHome, 'config.toml'),
      [
        'model_provider = "stale-provider"',
        '',
        '[hooks.state."orca:stop:0:0"]',
        'enabled = true',
        ''
      ].join('\n')
    )

    syncLegacySharedCodexHomeForRetainedPanes({ sharedRuntimeHome, systemCodexHome })

    expect(readFileSync(join(sharedRuntimeHome, 'auth.json'), 'utf-8')).toBe(systemAuth)
    const sharedConfig = readFileSync(join(sharedRuntimeHome, 'config.toml'), 'utf-8')
    expect(sharedConfig).toContain('model_provider = "codex-lb"')
    expect(sharedConfig).toContain('requires_openai_auth = true')
    expect(sharedConfig).not.toContain('stale-provider')
    expect(sharedConfig).toContain('[hooks.state."orca:stop:0:0"]')
    expect(readFileSync(join(systemCodexHome, 'config.toml'), 'utf-8')).toBe(systemConfig)
    if (process.platform !== 'win32') {
      expect(statSync(join(sharedRuntimeHome, 'auth.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('reflects a real-home logout without deleting a transiently missing config', () => {
    const staleConfig = 'model_provider = "stale-provider"\n'
    writeFileSync(join(sharedRuntimeHome, 'auth.json'), '{"tokens":{"access_token":"stale"}}\n')
    writeFileSync(join(sharedRuntimeHome, 'config.toml'), staleConfig, 'utf-8')

    syncLegacySharedCodexHomeForRetainedPanes({ sharedRuntimeHome, systemCodexHome })

    expect(existsSync(join(sharedRuntimeHome, 'auth.json'))).toBe(false)
    expect(readFileSync(join(sharedRuntimeHome, 'config.toml'), 'utf-8')).toBe(staleConfig)
  })

  it('does not promote retained-pane settings into the real home', () => {
    writeFileSync(join(systemCodexHome, 'auth.json'), '{"tokens":{"access_token":"system"}}\n')
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "canonical"\n', 'utf-8')
    writeFileSync(join(sharedRuntimeHome, 'config.toml'), 'model = "retained-pane-change"\n')

    syncLegacySharedCodexHomeForRetainedPanes({ sharedRuntimeHome, systemCodexHome })

    expect(readFileSync(join(systemCodexHome, 'config.toml'), 'utf-8')).toBe(
      'model = "canonical"\n'
    )
    expect(readFileSync(join(sharedRuntimeHome, 'config.toml'), 'utf-8')).toBe(
      'model = "canonical"\n'
    )
  })

  it('still refreshes config when the compatibility auth write fails', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(systemCodexHome, 'auth.json'), '{"tokens":{"access_token":"system"}}\n')
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "canonical"\n', 'utf-8')
    mkdirSync(join(sharedRuntimeHome, 'auth.json'))

    syncLegacySharedCodexHomeForRetainedPanes({ sharedRuntimeHome, systemCodexHome })

    expect(readFileSync(join(sharedRuntimeHome, 'config.toml'), 'utf-8')).toBe(
      'model = "canonical"\n'
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-runtime-home] Failed to refresh legacy shared auth:',
      expect.anything()
    )
  })
})
