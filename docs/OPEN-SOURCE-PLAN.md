# Codekin Open-Source Readiness Plan

Prepared: 2026-03-08

---

## 1. Licensing (Critical Blocker)

- No LICENSE file exists
- No `license` field in package.json
- **Recommendation**: **MIT** — simple, permissive, widely understood. Apache 2.0 is an alternative if explicit patent grants are desired.
- All 20+ dependencies use MIT/Apache 2.0 — no license conflicts with either choice.

### Actions

- [ ] Choose a license (MIT recommended)
- [ ] Add `LICENSE` file to repo root
- [ ] Add `license` field to package.json

---

## 2. Sensitive Data & Hardcoded Values (Must Fix)

| Issue | Location | Action |
|-------|----------|--------|
| Production domain | `nginx/` config | Replace with template/example config |
| SSL cert paths | nginx config | Same — make it a `.example` file |
| Developer paths (`/home/dev/...`) | `CLAUDE.md`, `docs/SETUP.md`, `.codekin/settings.json` | Replace with generic placeholders or env vars |
| Personal email in git history | Git history (earlier commits) | Squashed — resolved |
| Specific ports (32352, 32353) | Multiple files | Fine as defaults, just document they're configurable |

### Actions

- [ ] Rename `nginx/claude.trec.one` to `nginx/codekin.example` with placeholder values
- [ ] Replace all hardcoded `/home/dev/...` paths in docs with generic placeholders
- [ ] Review `.codekin/settings.json` for environment-specific values
- [ ] Decide on git history approach for personal email (see section 6)

---

## 3. Missing Community Files

| File | Status | Priority |
|------|--------|----------|
| `LICENSE` | Missing | **Critical** |
| `CONTRIBUTING.md` | Missing | High |
| `CODE_OF_CONDUCT.md` | Missing | High |
| `SECURITY.md` | Missing | High |
| `CHANGELOG.md` | Missing | Medium |
| `.github/ISSUE_TEMPLATE/` | Missing | Medium |
| `.github/PULL_REQUEST_TEMPLATE.md` | Missing | Medium |

### Actions

- [ ] Create `CONTRIBUTING.md` — dev setup, coding conventions, PR process
- [ ] Create `CODE_OF_CONDUCT.md` — adopt Contributor Covenant v2.1
- [ ] Create `SECURITY.md` — vulnerability reporting process
- [ ] Create `CHANGELOG.md` — document versions starting from first public release
- [ ] Create GitHub issue templates (bug report, feature request)
- [ ] Create GitHub PR template

---

## 4. CI/CD Gaps

**Current state**: Only a publish workflow (npm publish on version tags).

**Missing**: Test + lint on push/PR — essential for accepting contributions.

### Actions

- [ ] Add GitHub Actions workflow: run `npm test` and `npm run lint` on PRs
- [ ] Add GitHub Actions workflow: run tests on push to main
- [ ] Consider adding build verification step

---

## 5. Documentation Cleanup

**Current state**:
- `README.md` — exists, solid content
- `CLAUDE.md` — contains deployment-specific paths and auto-deploy instructions
- `docs/` — 11 files, ~6700 lines, comprehensive but environment-specific in places

### Actions

- [ ] Update `README.md`: add license badge, contributing link, feature screenshots
- [ ] Review `CLAUDE.md` for open-source context (remove deploy-on-every-commit instruction)
- [ ] Audit `docs/` files for environment-specific paths and replace with placeholders
- [ ] Add development setup guide (standalone or in CONTRIBUTING.md)

---

## 6. Git History Decision

**Current state**: 421 commits on a single branch.

| Option | Pros | Cons |
|--------|------|------|
| **Keep full history** | Transparency, shows evolution | Email exposed, messy WIP commits |
| **Squash to clean history** | Clean slate, no personal data | Loses context |
| **Rewrite with `git filter-repo`** | Fix email only, keep history | Complex, still has WIP commits |

**Recommendation**: Since this is a v0.x project, a **squashed fresh start** is simplest — create a clean initial commit or a small set of meaningful commits. This also removes the personal email concern.

### Actions

- [ ] Decide on history approach
- [ ] Execute chosen approach before making repo public
- [ ] Verify no sensitive data remains in final history

---

## 7. Branching & Release Policy

Suggested model for a small open-source project:

- **`main`** — stable, always releasable
- **Feature branches** — `feat/description`, merged via PR
- **Release tags** — `v0.2.0`, `v1.0.0` etc. (semver)
- **Branch protection** — require PR reviews, passing CI
- **No direct pushes to main** once public

### Actions

- [ ] Document branching policy in CONTRIBUTING.md
- [ ] Set up branch protection rules on GitHub after publishing
- [ ] Define versioning strategy (semver)

---

## 8. Package.json Metadata

Missing fields to add:

```json
{
  "license": "MIT",
  "author": "Multiplier Labs",
  "repository": {
    "type": "git",
    "url": "https://github.com/Multiplier-Labs/codekin"
  },
  "bugs": {
    "url": "https://github.com/Multiplier-Labs/codekin/issues"
  },
  "keywords": ["claude", "terminal", "ai", "coding-assistant"]
}
```

### Actions

- [ ] Add all missing metadata fields to package.json
- [ ] Verify `name`, `description`, and `version` are appropriate for public release

---

## Execution Order

1. **Choose license** → add LICENSE file + package.json field
2. **Scrub sensitive data** — template nginx config, replace hardcoded paths in docs
3. **Add community files** — CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
4. **Add CI workflow** — test + lint on PR
5. **Clean up README** — badges, screenshots, contributing section
6. **Update package.json metadata**
7. **Decide on git history** — squash or filter
8. **Set up branch protection rules** on GitHub
9. **Create CHANGELOG.md** and tag first public release
10. **Publish** — make repo public

---

## Dependencies Audit Summary

All dependencies use permissive open-source licenses (MIT / Apache 2.0). No conflicts found.

**Production**: react, react-dom, react-markdown, react-syntax-highlighter, ai, @ai-sdk/groq, @tabler/icons-react, cmdk, tailwindcss, remark-gfm

**Development**: typescript, vite, eslint, vitest, @types/*

No proprietary or restrictive dependencies detected.
