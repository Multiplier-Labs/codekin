---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata:
  id: coverage-increase
  name: Coverage Increase
  description: Add meaningful tests that exercise real behavior and edge cases; production code stays untouched.
agent:
  provider: auto
workspace:
  strategy: worktree
evaluators:
  - id: tests
    type: command
    command: npm test
    timeout: 15m
    retry: { maxAttempts: 2 }
  - id: review
    type: rubric
    provider: different-from-maker
    instructions: >
      Reject trivially-true assertions and tests that execute code without checking
      outcomes. Production-code changes are only acceptable when they fix a genuine
      bug the new test reveals, called out explicitly.
budgets:
  turns: 15
  costUsd: 6
  wallTime: 2h
policy:
  mode: guarded
completion:
  action: pull-request
---
Increase meaningful test coverage for this codebase by adding tests that exercise
real behavior and edge cases.

- Add tests only; do NOT change production code to make coverage easier unless you
  are fixing a genuine bug the new test reveals (call that out explicitly).
- Tests must assert real behavior — no trivially-true assertions, no tests that
  only execute code without checking outcomes.
- Keep each test focused and readable; prefer covering untested branches and error
  paths over padding already-covered lines.
- Every evaluator must pass before you finish.
