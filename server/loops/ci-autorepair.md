---
kind: ci-autorepair
name: CI Autorepair
maker:
  provider: claude
checker:
  provider: opencode
verify:
  - npm test
  - npm run lint
readonly:
  - .github/workflows/**
maxTurns: 12
maxCostUsd: 5
completionPolicy: pr
---
The continuous integration checks are failing on this branch. Diagnose the failures
and fix the underlying cause so that every verification command passes.

- Make the smallest change that fixes the root cause; do not refactor unrelated code.
- Do NOT weaken, skip, delete, or relax tests to make verification pass.
- Do NOT modify CI workflow configuration to sidestep the failure.
- If the failure is environmental or genuinely cannot be fixed in code, stop and
  explain why rather than forcing a green result.
