---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata:
  id: ci-autorepair
  name: CI Autorepair
  description: Diagnose failing CI on the current branch and repair the root cause without weakening tests.
agent:
  provider: auto
workspace:
  strategy: worktree
  protectedPaths:
    - ".github/workflows/**"
evaluators:
  - id: tests
    type: command
    command: npm test
    timeout: 15m
    retry: { maxAttempts: 2 }
  - id: lint
    type: command
    command: npm run lint
  - id: review
    type: rubric
    provider: different-from-maker
    instructions: >
      Confirm the fix addresses the root cause rather than symptoms, and that no
      test was weakened, skipped, or deleted to force a green result.
budgets:
  turns: 12
  costUsd: 5
  wallTime: 90m
policy:
  mode: guarded
completion:
  action: pull-request
---
The continuous integration checks are failing on this branch. Diagnose the failures
and fix the underlying cause so that every evaluator passes.

- Make the smallest change that fixes the root cause; do not refactor unrelated code.
- Do NOT weaken, skip, delete, or relax tests to make evaluation pass.
- Do NOT modify CI workflow configuration to sidestep the failure.
- If the failure is environmental or genuinely cannot be fixed in code, stop and
  explain why rather than forcing a green result.
