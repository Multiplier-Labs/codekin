/**
 * New loop wizard — four steps to a running loop, with no free-text
 * filesystem paths (spec §5.2):
 *
 *   1 Scope    — repository picker (cloned repos) + base branch + work branch
 *   2 Outcome  — recipe (repo-aware discovery) + outcome prompt
 *   3 Control  — mode, plan gate, budgets (prefilled from the recipe)
 *   4 Preflight— the exact effective run config from POST /runs/preflight;
 *                the submit button says what will happen.
 *
 * Repo selection comes first (a deliberate reorder of the spec's
 * outcome-first sketch) because recipe discovery is repo-scoped — a repo's
 * `.codekin/loops/` overrides are only visible once the repo is chosen.
 */

import { useState, useEffect } from 'react'
import { IconCheck, IconArrowRight, IconArrowLeft, IconLoader2 } from '@tabler/icons-react'
import { RepoList } from './RepoList'
import { useRepos } from '../hooks/useRepos'
import {
  listLoopRecipes,
  listLoopBranches,
  preflightLoopRun,
  startLoopRun,
  type LoopRecipeInfo,
  type LoopRun,
  type EffectiveLoopConfig,
  type StartLoopInput,
} from '../lib/loopsApi'

type Step = 1 | 2 | 3 | 4

interface FormState {
  repoId: string
  repoPath: string
  repoName: string
  baseBranch: string
  branch: string
  recipeId: string
  goal: string
  mode: 'guided' | 'guarded' | 'autonomous'
  planRequired: boolean
  turns: number
  costUsd: number
  wallTimeMinutes: number | null
}

const MODE_HELP: Record<FormState['mode'], string> = {
  guided: 'Approve the plan and the completion before anything lands. For unfamiliar or high-risk work.',
  guarded: 'Runs on its own; interrupts you at escalations and budget boundaries. The default.',
  autonomous: 'Runs to a policy boundary and stops with a partial result instead of waiting on you.',
}

function StepIndicator({ current }: { current: Step }) {
  const steps = [
    { num: 1 as const, label: 'Scope' },
    { num: 2 as const, label: 'Outcome' },
    { num: 3 as const, label: 'Control' },
    { num: 4 as const, label: 'Preflight' },
  ]
  return (
    <div className="mb-5 flex items-center gap-1">
      {steps.map((s, i) => (
        <div key={s.num} className="flex flex-1 items-center gap-1">
          <div className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-meta font-semibold ${
                s.num < current ? 'bg-success-7 text-ink-inverse' : s.num === current ? 'bg-accent-7 text-ink-inverse' : 'bg-edge text-ink-muted'
              }`}
            >
              {s.num < current ? <IconCheck size={12} stroke={3} /> : s.num}
            </span>
            <span className={`text-body font-medium ${s.num === current ? 'text-ink' : 'text-ink-muted'}`}>{s.label}</span>
          </div>
          {i < steps.length - 1 && <div className={`mx-1 h-px flex-1 ${s.num < current ? 'bg-success-7' : 'bg-edge-strong'}`} />}
        </div>
      ))}
    </div>
  )
}

const inputClasses =
  'rounded-control border border-edge bg-surface px-2 py-1.5 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-meta text-ink-muted">
      {label}
      {children}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Step 1 — Scope
// ---------------------------------------------------------------------------

function StepScope({
  token,
  form,
  onChange,
}: {
  token: string
  form: FormState
  onChange: (patch: Partial<FormState>) => void
}) {
  const { groups, loading, error } = useRepos(token)
  const [branches, setBranches] = useState<string[]>([])
  const [branchesError, setBranchesError] = useState<string | null>(null)

  // Only cloned repos can run a loop — the worktree needs a local checkout.
  const clonedGroups = groups
    .map((g) => ({ ...g, repos: g.repos.filter((r) => r.cloned) }))
    .filter((g) => g.repos.length > 0)

  useEffect(() => {
    if (!form.repoPath) return
    let cancelled = false
    listLoopBranches(token, form.repoPath)
      .then(({ branches: list, defaultBranch }) => {
        if (cancelled) return
        setBranches(list)
        setBranchesError(null)
        onChange({ baseBranch: form.baseBranch && list.includes(form.baseBranch) ? form.baseBranch : (defaultBranch ?? list[0] ?? '') })
      })
      .catch((err: unknown) => {
        if (!cancelled) setBranchesError(err instanceof Error ? err.message : 'Failed to list branches')
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the repo changes
  }, [token, form.repoPath])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-body text-ink-muted">
        <IconLoader2 size={16} stroke={2} className="animate-spin" /> Loading repositories…
      </div>
    )
  }
  if (error) {
    return <div className="rounded-control bg-error-10/50 px-3 py-2 text-body text-error-4">Failed to load repos: {error}</div>
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-ink-muted">Choose the repository and the branch the loop starts from.</p>
      <RepoList
        groups={clonedGroups}
        selectedId={form.repoId}
        onSelect={(repo) => { onChange({ repoId: repo.id, repoPath: repo.path, repoName: repo.name, recipeId: '' }) }}
        maxHeight="260px"
      />
      {form.repoPath && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Base branch (starting point)">
            <select
              value={form.baseBranch}
              onChange={(e) => { onChange({ baseBranch: e.target.value }) }}
              className={inputClasses}
            >
              {branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </Field>
          <Field label="Work branch (optional — generated when empty)">
            <input
              value={form.branch}
              onChange={(e) => { onChange({ branch: e.target.value }) }}
              placeholder="loop/fix-ci"
              className={inputClasses}
            />
          </Field>
        </div>
      )}
      {branchesError && <p className="text-meta text-error-4">{branchesError}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — Outcome
// ---------------------------------------------------------------------------

function StepOutcome({
  token,
  form,
  onChange,
}: {
  token: string
  form: FormState
  onChange: (patch: Partial<FormState>) => void
}) {
  const [recipes, setRecipes] = useState<LoopRecipeInfo[]>([])

  useEffect(() => {
    let cancelled = false
    listLoopRecipes(token, form.repoPath || undefined)
      .then((list) => { if (!cancelled) setRecipes(list) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token, form.repoPath])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-ink-muted">Pick a recipe, then state the outcome this run should achieve.</p>
      <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {recipes.map((r) => (
          <button
            key={r.id}
            onClick={() => { onChange({ recipeId: r.id }) }}
            className={`rounded-control border px-3 py-2 text-left transition-colors ${
              form.recipeId === r.id ? 'border-accent-7 bg-accent-9/20' : 'border-edge hover:bg-surface-raised'
            }`}
          >
            <span className="flex items-center gap-2">
              <span className="text-body font-medium text-ink">{r.name}</span>
              {r.source === 'repo' && <span className="rounded-control bg-edge px-1.5 py-0.5 text-micro text-ink-muted">repo</span>}
            </span>
            {r.description && <span className="mt-0.5 block text-meta text-ink-muted">{r.description}</span>}
          </button>
        ))}
        {recipes.length === 0 && <p className="py-4 text-center text-meta text-ink-muted">No recipes found.</p>}
      </div>
      <Field label="Outcome (optional — defaults to the recipe's outcome prompt)">
        <textarea
          value={form.goal}
          onChange={(e) => { onChange({ goal: e.target.value }) }}
          rows={4}
          placeholder="What should this run achieve? Leave empty to use the recipe's default."
          className={inputClasses}
        />
      </Field>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 3 — Control
// ---------------------------------------------------------------------------

function StepControl({ form, onChange }: { form: FormState; onChange: (patch: Partial<FormState>) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-meta text-ink-muted">Mode</span>
        {(['guided', 'guarded', 'autonomous'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => { onChange({ mode }) }}
            className={`rounded-control border px-3 py-2 text-left transition-colors ${
              form.mode === mode ? 'border-accent-7 bg-accent-9/20' : 'border-edge hover:bg-surface-raised'
            }`}
          >
            <span className="text-body font-medium capitalize text-ink">{mode}</span>
            <span className="mt-0.5 block text-meta text-ink-muted">{MODE_HELP[mode]}</span>
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-body text-ink">
        <input
          type="checkbox"
          checked={form.planRequired}
          onChange={(e) => { onChange({ planRequired: e.target.checked }) }}
          className="accent-current"
        />
        Require an explicit plan before any file changes
        {form.mode === 'guided' && <span className="text-meta text-ink-muted">(guided mode gates execution on plan approval)</span>}
      </label>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Turn budget">
          <input
            type="number"
            min={1}
            value={form.turns}
            onChange={(e) => { onChange({ turns: Math.max(1, Number(e.target.value) || 1) }) }}
            className={inputClasses}
          />
        </Field>
        <Field label="Cost budget (USD)">
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={form.costUsd}
            onChange={(e) => { onChange({ costUsd: Math.max(0.5, Number(e.target.value) || 0.5) }) }}
            className={inputClasses}
          />
        </Field>
        <Field label="Wall time (minutes, empty = unlimited)">
          <input
            type="number"
            min={5}
            value={form.wallTimeMinutes ?? ''}
            onChange={(e) => { onChange({ wallTimeMinutes: e.target.value === '' ? null : Math.max(5, Number(e.target.value) || 5) }) }}
            className={inputClasses}
          />
        </Field>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 4 — Preflight
// ---------------------------------------------------------------------------

function PreflightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-body">
      <span className="w-32 flex-shrink-0 text-ink-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink">{value}</span>
    </div>
  )
}

function StepPreflight({ effective, error }: { effective: EffectiveLoopConfig | null; error: string | null }) {
  if (error) return <div className="rounded-control bg-error-10/50 px-3 py-2 text-body text-error-4">{error}</div>
  if (!effective) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-body text-ink-muted">
        <IconLoader2 size={16} stroke={2} className="animate-spin" /> Resolving the effective run configuration…
      </div>
    )
  }
  const r = effective.recipe
  const budgets = [
    `${r.budgets.turns} turns`,
    `$${r.budgets.costUsd}`,
    r.budgets.wallTimeMs ? `${Math.round(r.budgets.wallTimeMs / 60000)} min wall time` : null,
  ].filter(Boolean).join(' · ')
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body text-ink-muted">This is exactly what will run — nothing has been spent yet.</p>
      <div className="flex flex-col gap-1.5 rounded-control border border-edge p-3">
        <PreflightRow label="Recipe" value={`${r.name} (${r.id})`} />
        <PreflightRow label="Repository" value={effective.repo} />
        <PreflightRow label="Branches" value={`${effective.branch} off ${effective.baseBranch ?? 'the default branch'}`} />
        <PreflightRow label="Agent" value={effective.model ? `${effective.provider} (${effective.model})` : effective.provider} />
        <PreflightRow label="Mode" value={`${r.policy.mode}${r.plan.required ? ' · plan required' : ''}`} />
        <PreflightRow
          label="Checks"
          value={r.evaluators
            .map((e) => (e.type === 'command' ? (Array.isArray(e.command) ? e.command.join(' ') : (e.command ?? e.id)) : `${e.type}: ${e.id}`))
            .join(' → ')}
        />
        {r.workspace.protectedPaths.length > 0 && <PreflightRow label="Protected" value={r.workspace.protectedPaths.join(', ')} />}
        <PreflightRow label="Budgets" value={budgets} />
        <PreflightRow label="On success" value={r.completion.action === 'pull-request' ? 'commit, push, open a PR' : 'commit locally only'} />
      </div>
      <p className="line-clamp-4 whitespace-pre-wrap text-meta text-ink-muted">{effective.goal}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wizard shell
// ---------------------------------------------------------------------------

export function NewLoopWizard({ token, onClose, onStarted }: { token: string; onClose: () => void; onStarted: (run: LoopRun) => void }) {
  const [step, setStep] = useState<Step>(1)
  const [form, setForm] = useState<FormState>({
    repoId: '',
    repoPath: '',
    repoName: '',
    baseBranch: '',
    branch: '',
    recipeId: '',
    goal: '',
    mode: 'guarded',
    planRequired: false,
    turns: 12,
    costUsd: 5,
    wallTimeMinutes: null,
  })
  const [effective, setEffective] = useState<EffectiveLoopConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [defaultsFor, setDefaultsFor] = useState('')

  const updateForm = (patch: Partial<FormState>) => { setForm((f) => ({ ...f, ...patch })) }

  const startInput = (withOverrides: boolean): StartLoopInput => ({
    recipeId: form.recipeId,
    repo: form.repoPath,
    branch: form.branch.trim() || undefined,
    baseBranch: form.baseBranch || undefined,
    goal: form.goal.trim() || undefined,
    ...(withOverrides
      ? {
          overrides: {
            mode: form.mode,
            planRequired: form.planRequired,
            budgets: {
              turns: form.turns,
              costUsd: form.costUsd,
              ...(form.wallTimeMinutes !== null ? { wallTimeMinutes: form.wallTimeMinutes } : {}),
            },
          },
        }
      : {}),
  })

  // Entering Control: prefill defaults from the recipe (via a no-override
  // preflight). Entering Preflight: resolve the final effective config.
  useEffect(() => {
    if (step === 3 && form.recipeId && defaultsFor !== `${form.repoPath}:${form.recipeId}`) {
      preflightLoopRun(token, startInput(false))
        .then((eff) => {
          setDefaultsFor(`${form.repoPath}:${form.recipeId}`)
          setForm((f) => ({
            ...f,
            mode: eff.recipe.policy.mode,
            planRequired: eff.recipe.plan.required,
            turns: eff.recipe.budgets.turns,
            costUsd: eff.recipe.budgets.costUsd,
            wallTimeMinutes: eff.recipe.budgets.wallTimeMs ? Math.round(eff.recipe.budgets.wallTimeMs / 60000) : null,
          }))
        })
        .catch(() => {})
    }
    if (step === 4) {
      setEffective(null)
      setError(null)
      preflightLoopRun(token, startInput(true))
        .then(setEffective)
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Preflight failed') })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on step entry only
  }, [step])

  const canNext = step === 1 ? form.repoPath !== '' && form.baseBranch !== '' : step === 2 ? form.recipeId !== '' : true

  const submit = () => {
    setBusy(true)
    setError(null)
    startLoopRun(token, startInput(true))
      .then(onStarted)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to start run')
        setBusy(false)
      })
  }

  const submitLabel =
    effective?.recipe.completion.action === 'commit-only'
      ? 'Start in isolated worktree; commit locally'
      : effective?.recipe.plan.required && effective.recipe.policy.mode === 'guided'
        ? 'Start in isolated worktree; plan needs your approval'
        : 'Start in isolated worktree; open PR when checks pass'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-floating border border-edge-strong bg-surface-raised p-4 shadow-floating"
        onClick={(e) => { e.stopPropagation() }}
      >
        <h2 className="mb-4 text-title text-ink">New loop</h2>
        <StepIndicator current={step} />
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {step === 1 ? (
            <StepScope token={token} form={form} onChange={updateForm} />
          ) : step === 2 ? (
            <StepOutcome token={token} form={form} onChange={updateForm} />
          ) : step === 3 ? (
            <StepControl form={form} onChange={updateForm} />
          ) : (
            <StepPreflight effective={effective} error={error} />
          )}
        </div>
        {error && step !== 4 && <div className="mt-2 rounded-control bg-error-10/50 px-3 py-2 text-body text-error-4">{error}</div>}
        <div className="mt-4 flex items-center gap-2">
          {step > 1 && (
            <button
              onClick={() => { setStep((s) => (s - 1) as Step) }}
              className="flex items-center gap-1 rounded-control px-3 py-1.5 text-body text-ink-muted hover:bg-surface transition-colors"
            >
              <IconArrowLeft size={14} stroke={2} /> Back
            </button>
          )}
          <button onClick={onClose} className="rounded-control px-3 py-1.5 text-body text-ink-muted hover:bg-surface transition-colors">
            Cancel
          </button>
          <div className="flex-1" />
          {step < 4 ? (
            <button
              onClick={() => { setStep((s) => (s + 1) as Step) }}
              disabled={!canNext}
              className="flex items-center gap-1 rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-40 transition-colors"
            >
              Next <IconArrowRight size={14} stroke={2} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={busy || !effective}
              className="flex items-center gap-1 rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-40 transition-colors"
            >
              {busy ? <IconLoader2 size={14} stroke={2} className="animate-spin" /> : <IconCheck size={14} stroke={2} />}
              {submitLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
