---
kind: coverage-increase
name: Coverage Increase
maker:
  provider: claude
checker:
  provider: opencode
verify:
  - npm test
maxTurns: 15
maxCostUsd: 6
completionPolicy: pr
---
Increase meaningful test coverage for this codebase by adding tests that exercise
real behavior and edge cases.

- Add tests only; do NOT change production code to make coverage easier unless you
  are fixing a genuine bug the new test reveals (call that out explicitly).
- Tests must assert real behavior — no trivially-true assertions, no tests that
  only execute code without checking outcomes.
- Keep each test focused and readable; prefer covering untested branches and error
  paths over padding already-covered lines.
- Every verification command must pass before you finish.
