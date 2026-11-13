/**
 * Which PR Review automation, if any, governs a pull request event.
 *
 * GitHub only tells the webhook the repo's `owner/name`; automations are keyed
 * by a local repo path. They are matched through each repo's origin remote.
 *
 * Until a PR Review automation has ever been saved, every repo is reviewed
 * with the default agent (`legacy`), so installs that relied on the webhook
 * alone keep working. After that, the automation decides: no automation, or a
 * paused one, means no review.
 */

import { loadWorkflowConfig, type ReviewRepoConfig, type WorkflowConfig } from './workflow-config.js'
import { repoSlugFromRemote } from './repo-activity.js'

/** The settings a PR review session takes from its automation. */
export interface PrReviewSettings {
  automationId: string
  model?: string
  provider?: ReviewRepoConfig['provider']
  customPrompt?: string
}

export type PrReviewDecision =
  | { kind: 'legacy' }
  | { kind: 'review'; settings: PrReviewSettings }
  | { kind: 'skip'; reason: string }

export interface PrReviewDeps {
  load: () => WorkflowConfig
  /** `owner/name` (lowercase) of a local repo's origin, or null. */
  slugOf: (repoPath: string) => string | null
  /** Why an automation is held right now (e.g. its maintenance plan is paused), or null. */
  holdReason?: (automationId: string) => string | null
}

const slugCache = new Map<string, string | null>()
let holdReason: ((automationId: string) => string | null) | null = null

/** Wire the maintenance hold, so a paused plan pauses its PR Review automation too. */
export function setPrReviewHold(fn: ((automationId: string) => string | null) | null): void {
  holdReason = fn
}

const defaultDeps: PrReviewDeps = {
  load: loadWorkflowConfig,
  slugOf: (repoPath) => {
    if (!slugCache.has(repoPath)) slugCache.set(repoPath, repoSlugFromRemote(repoPath))
    return slugCache.get(repoPath) ?? null
  },
  holdReason: (id) => holdReason?.(id) ?? null,
}

export function resolvePrReviewAutomation(slug: string, deps: PrReviewDeps = defaultDeps): PrReviewDecision {
  const config = deps.load()
  const rows = config.reviewRepos.filter(r => r.kind === 'pr-review')
  if (rows.length === 0 && !config.prReviewAutomationsAdopted) return { kind: 'legacy' }

  const wanted = slug.toLowerCase()
  const matching = rows.filter(r => deps.slugOf(r.repoPath) === wanted)
  if (matching.length === 0) {
    return { kind: 'skip', reason: `No PR Review automation for ${slug}` }
  }
  const row = matching.find(r => r.enabled)
  if (!row) {
    return { kind: 'skip', reason: `The PR Review automation for ${slug} is paused` }
  }
  let held: string | null
  try {
    held = deps.holdReason?.(row.id) ?? null
  } catch {
    held = null // a failing hold check fails open, as the engine's dispatch gate does
  }
  if (held) return { kind: 'skip', reason: `The PR Review automation for ${slug} is held: ${held}` }
  return {
    kind: 'review',
    settings: {
      automationId: row.id,
      ...(row.model ? { model: row.model } : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.customPrompt?.trim() ? { customPrompt: row.customPrompt.trim() } : {}),
    },
  }
}
