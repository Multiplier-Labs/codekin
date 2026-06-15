---
kind: dependency-upgrade
name: Dependency Upgrade
maker:
  provider: claude
checker:
  provider: opencode
verify:
  - npm install
  - npm run build
  - npm test
readonly:
  - .github/workflows/**
maxTurns: 12
maxCostUsd: 6
completionPolicy: pr
---
Upgrade the project's dependencies and adapt the code to any breaking changes so
that the build and the full test suite pass on the new versions.

- Update package.json and the lockfile together; keep the dependency tree consistent.
- Make the minimal source changes required to accommodate breaking API changes.
- Do NOT weaken or delete tests to absorb a breaking change — fix the calling code.
- Do NOT pin to an older version to avoid the work unless an upgrade is genuinely
  incompatible; if so, stop and explain which dependency blocked the upgrade.
- Every verification command must pass before you finish.
