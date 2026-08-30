---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata:
  id: dependency-upgrade
  name: Dependency Upgrade
  description: Upgrade dependencies and adapt code to breaking changes until install, build, and tests pass.
agent:
  provider: auto
workspace:
  strategy: worktree
  protectedPaths:
    - ".github/workflows/**"
evaluators:
  - id: install
    type: command
    command: npm install
    timeout: 10m
    retry: { maxAttempts: 2 }
  - id: build
    type: command
    command: npm run build
    timeout: 15m
  - id: tests
    type: command
    command: npm test
    timeout: 15m
    retry: { maxAttempts: 2 }
  - id: review
    type: rubric
    provider: different-from-maker
    instructions: >
      Verify package.json and the lockfile moved together, that no test was weakened
      to absorb a breaking change, and that no dependency was silently pinned back.
budgets:
  turns: 12
  costUsd: 6
  wallTime: 2h
policy:
  mode: guarded
completion:
  action: pull-request
---
Upgrade the project's dependencies and adapt the code to any breaking changes so
that the build and the full test suite pass on the new versions.

- Update package.json and the lockfile together; keep the dependency tree consistent.
- Make the minimal source changes required to accommodate breaking API changes.
- Do NOT weaken or delete tests to absorb a breaking change — fix the calling code.
- Do NOT pin to an older version to avoid the work unless an upgrade is genuinely
  incompatible; if so, stop and explain which dependency blocked the upgrade.
- Every evaluator must pass before you finish.
