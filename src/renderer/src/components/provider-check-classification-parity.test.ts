import { describe, expect, it } from 'vitest'
import { deriveTaskPagePRCheckSummary } from './task-page-pr-check-summary'
import { derivePipelineStatus } from '../../../main/gitlab/mappers'
import { gitLabPipelineJobsToPRChecks } from '../../../shared/gitlab-pipeline-checks'
import { derivePRCheckStatus, derivePRCheckStatusFromRollup } from '../../../shared/pr-check-status'
import {
  getProviderChecksLabel,
  summarizeProviderChecks
} from '../../../shared/provider-check-summary'
import type { GitLabPipelineJob } from '../../../shared/gitlab-types'
import type { PRCheckDetail, ProviderCheckSummary } from '../../../shared/types'

function completed(conclusion: string): PRCheckDetail {
  return {
    name: conclusion,
    status: 'completed',
    conclusion: conclusion as PRCheckDetail['conclusion'],
    url: null
  }
}

function gitLabJobs(...statuses: string[]): PRCheckDetail[] {
  return gitLabPipelineJobsToPRChecks(
    statuses.map(
      (status, index): GitLabPipelineJob => ({
        id: index,
        name: status,
        stage: 'deploy',
        status,
        webUrl: '',
        duration: null
      })
    )
  )
}

// Why: GraphQL rollups arrive upper-cased and status-first; the main process must land on the
// same verdict as the renderer for the same checks.
function toGraphQLRollup(check: PRCheckDetail): { status: string; conclusion: string | null } {
  return {
    status: check.status.toUpperCase(),
    conclusion: check.conclusion ? check.conclusion.toUpperCase() : null
  }
}

type ParityExpectation = Omit<ProviderCheckSummary, 'total'>

type ParityCase = {
  name: string
  checks: PRCheckDetail[]
  /** Set when the case also pins the main-process job-array rollup for the same jobs. */
  gitLabJobStatuses?: string[]
  expected: ParityExpectation
}

function gitLabCase(name: string, statuses: string[], expected: ParityExpectation): ParityCase {
  return { name, checks: gitLabJobs(...statuses), gitLabJobStatuses: statuses, expected }
}

const PARITY_CASES: ParityCase[] = [
  {
    name: 'all success',
    checks: [completed('success'), completed('success')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus skipped',
    checks: [completed('success'), completed('skipped')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'all skipped',
    checks: [completed('skipped'), completed('skipped')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus neutral',
    checks: [completed('success'), completed('neutral')],
    expected: { state: 'success', passed: 1, failed: 0, pending: 0, neutral: 1 }
  },
  {
    name: 'all neutral',
    checks: [completed('neutral')],
    expected: { state: 'neutral', passed: 0, failed: 0, pending: 0, neutral: 1 }
  },
  {
    name: 'success plus failure',
    checks: [completed('success'), completed('failure')],
    expected: { state: 'failure', passed: 1, failed: 1, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus running',
    checks: [
      completed('success'),
      { name: 'ci', status: 'in_progress', conclusion: null, url: null }
    ],
    expected: { state: 'pending', passed: 1, failed: 0, pending: 1, neutral: 0 }
  },
  gitLabCase('GitLab manual gate only', ['manual'], {
    state: 'neutral',
    passed: 0,
    failed: 0,
    pending: 0,
    neutral: 1
  }),
  gitLabCase('GitLab manual gate alongside a green pipeline', ['manual', 'success'], {
    state: 'success',
    passed: 1,
    failed: 0,
    pending: 0,
    neutral: 1
  }),
  gitLabCase('GitLab skipped-only pipeline', ['skipped', 'skipped'], {
    state: 'success',
    passed: 2,
    failed: 0,
    pending: 0,
    neutral: 0
  }),
  gitLabCase('GitLab success alongside an unrecognized job status', ['success', 'wat'], {
    state: 'success',
    passed: 1,
    failed: 0,
    pending: 0,
    neutral: 1
  }),
  gitLabCase('GitLab canceled job', ['success', 'canceled'], {
    state: 'failure',
    passed: 1,
    failed: 1,
    pending: 0,
    neutral: 0
  }),
  gitLabCase('GitLab manual gate alongside a running job', ['manual', 'running'], {
    state: 'pending',
    passed: 0,
    failed: 0,
    pending: 1,
    neutral: 1
  }),
  {
    name: 'genuine action_required',
    checks: [completed('success'), completed('action_required')],
    expected: { state: 'failure', passed: 1, failed: 1, pending: 0, neutral: 0 }
  }
]

describe('provider check classification parity', () => {
  it.each(PARITY_CASES)(
    '$name resolves identically on every desktop surface',
    ({ checks, expected, gitLabJobStatuses }) => {
      const summary = { ...expected, total: checks.length }
      expect(summarizeProviderChecks(checks)).toEqual(summary)
      expect(deriveTaskPagePRCheckSummary(checks)).toEqual(summary)
      expect(derivePRCheckStatus(checks)).toBe(expected.state)
      expect(derivePRCheckStatusFromRollup(checks.map(toGraphQLRollup))).toBe(expected.state)
      if (gitLabJobStatuses) {
        // Why: the main-process job-array rollup is a fourth surface for the same jobs.
        expect(derivePipelineStatus(gitLabJobStatuses.map((status) => ({ status })))).toBe(
          expected.state
        )
      }
      // Why: the pill's label, tone and icon all read this one summary, so a green pill must never say "unresolved".
      expect(getProviderChecksLabel(summary).includes('Unresolved')).toBe(
        expected.state === 'neutral'
      )
    }
  )

  it('labels a green PR carrying one neutral check as passing', () => {
    const checks = [...Array.from({ length: 19 }, () => completed('success')), completed('neutral')]
    expect(getProviderChecksLabel(summarizeProviderChecks(checks))).toBe('19/20 passed')
  })
})
