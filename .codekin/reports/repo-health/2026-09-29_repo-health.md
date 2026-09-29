# Repository Health: codekin

**Date**: 2026-09-29T03:18:46.792Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: fix/settings-standalone-view
**Workflow Run**: 9698b691-61b8-4021-a8a6-227bbdf13522
**Session**: 2e472ff6-36d6-49fd-a14c-0d34b89d3977

---

# Codekin Repository Health Report — 2026-09-29

---

## Summary

**Overall Health: Good**

The repository is in active, high-quality development. v0.9.0 and v0.9.1 were both shipped on 2026-09-28, delivering a major Settings overhaul, full workspaces/2FA infrastructure, and 9 colour themes. TypeScript strict mode, `noUnusedLocals`, and tight ESLint guards keep code quality high. The only notable concerns are a single orphaned component created during the Settings refactor, a long-lived conflicting PR (#626), and a large accumulation of stale automated-audit branches.

| Metric | Count |
|---|---|
| Dead code items | 1 (orphan component) |
| Stale TODO/FIXME | 0 |
| Config issues | 1 minor (no Prettier config) |
| License concerns | 0 (2 packages missing SPDX identifier, both low-risk) |
| Doc drift items | 1 minor |
| Stale branches (>30 days) | 43 total (17 feature/fix, 26 automated audit) |
| Open PRs | 2 |
| Stuck PRs (>7 days, no review) | 1 (#626, 28 days, CONFLICTING) |

---

## Dead Code

> The project uses `noUnusedLocals: true` and `noUnusedParameters: true` in all three tsconfig targets, so dead locals/params are caught at compile time. The analysis below focuses on unused *exports* and orphan files that the compiler does not detect.

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| `src/components/settings/SectionCard.tsx` | `SectionCard` | orphan file (unused export) | Remove or wire up. Created during settings refactor (#651) but never imported elsewhere in `src/`. The file exports a single layout helper that appears to have been superseded before use. |

All other "orphan" false-positives (`App.tsx`, `HostedApp.tsx`, `ShareDialog.tsx`, `lib/transport/index.ts`) are lazy-imported via dynamic `import()` or re-exported via barrel, not statically referenced at analysis time — confirmed live.

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, `WORKAROUND`, or `XXX` developer comments exist in the source tree. The only matches are:

- `src/hosted/PairPage.tsx:1` — `XXXX-XXXX` appears in a JSDoc and a placeholder string for the pairing code input format, not a developer annotation.
- Three test-fixture strings in `server/claude-process.test.ts` and `server/opencode-process.test.ts` that assert the pattern `'TODO'` as a Grep tool input, not a comment.

**Summary:** 0 TODO · 0 FIXME · 0 HACK · 0 stale items

---

## Config Drift

### `tsconfig.app.json` / `tsconfig.node.json` (frontend)

| Setting | Current Value | Notes |
|---|---|---|
| `strict` | `true` | ✓ Correct |
| `noUnusedLocals` | `true` | ✓ Correct |
| `noUnusedParameters` | `true` | ✓ Correct |
| `noImplicitReturns` | `true` | ✓ Correct |
| `noFallthroughCasesInSwitch` | `true` | ✓ Correct |
| `target` | `ES2023` | ✓ Modern |
| `erasableSyntaxOnly` | `true` | ✓ Forward-looking (erase-only syntax) |

### `server/tsconfig.json`

| Setting | Current Value | Notes |
|---|---|---|
| `strict` | `true` | ✓ |
| `noUnusedLocals` | `true` | ✓ |
| `noUnusedParameters` | `true` | ✓ |
| `target` | `ES2023` | ✓ |
| `moduleResolution` | `NodeNext` | ✓ Correct for Node ESM |

### `eslint.config.mjs`

The config uses `typescript-eslint`'s `strictTypeChecked` preset — an industry-leading baseline. Several rules are intentionally demoted to `warn` for incremental adoption (e.g. `restrict-template-expressions`, `no-non-null-assertion`, `no-misused-promises`). The config includes a custom AST-based guard enforcing semantic colour tokens — this is a non-standard but deliberate and well-documented addition.

**Finding (minor):** Several rules demoted to `warn` include `@typescript-eslint/no-non-null-assertion` and `@typescript-eslint/require-await`. These are commonly promoted to `error` once a codebase matures. The inline comment acknowledges this intent.

### Prettier

**Finding:** No Prettier configuration file exists (`.prettierrc`, `prettier.config.*`). Formatting consistency relies on editor defaults or individual developer settings. Adding a minimal Prettier config (or agreeing on `biome`) would prevent format-noise in diffs.

---

## License Compliance

The project is MIT-licensed. No GPL, LGPL, or AGPL dependencies were found.

| License | Dependency count |
|---|---|
| MIT | 510 |
| ISC | 31 |
| Apache-2.0 | 18 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 10 |
| BSD-2-Clause | 9 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| 0BSD | 1 |
| CC0-1.0 | 1 |
| CC-BY-4.0 | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| UNKNOWN (no SPDX field) | 2 |

**Flagged (low risk):**

| Package | Issue |
|---|---|
| `busboy` | No SPDX `license` field in `package.json`. Known MIT — maintained by the `fastify` org. |
| `streamsearch` | No SPDX `license` field. A transitive dependency of `multer`/`busboy`, also MIT. |

Neither package represents a compliance risk; both are well-known MIT libraries. The missing field is a packaging oversight on the dependency's side.

---

## Documentation Freshness

### API Docs

`docs/API-REFERENCE.md` covers WebSocket message types and REST endpoints. The Settings view added new endpoints (permissions bulk-load, profile, workspace) in PRs #651–#654 and #659. A quick review confirms the spec (`docs/SETTINGS-VIEW-SPEC.md`) was updated in #651 and marked **Complete** at the top of the file. However, `docs/API-REFERENCE.md` may not reflect the new `/api/approvals` single-request endpoint introduced in #659.

**Flag:** `docs/API-REFERENCE.md` — verify that the consolidated `/api/approvals` endpoint and the new Settings-section REST routes are documented.

### README Drift

The README was substantially updated in #661 (2026-09-28) to align with codekin.ai messaging. A cross-check of README commands against `package.json` scripts:

| README command | `package.json` entry | Status |
|---|---|---|
| `npm run dev` | `vite` | ✓ |
| `npm run build` | `tsc -b && vite build` | ✓ |
| `npm test` | `vitest run` | ✓ |
| `npm run lint` | `eslint .` | ✓ |
| `codekin token` | CLI command | ✓ (documented in CLI section) |
| `codekin upgrade` | CLI command | ✓ |

No README drift detected — the README is up to date.

### Spec Documents

`docs/SETTINGS-VIEW-SPEC.md` — marked **Complete: PR 1 #651, PR 2 #652, PR 3** at the top. ✓

`docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md` — phases 0–3 marked deployed per #650. ✓

`docs/HOSTED-SECURITY-AUDIT-2026-09-28.md` — matches the isolation fixes shipped in #655. ✓

---

## Draft Changelog

The last tag is `v0.9.0` (2026-09-28). `v0.9.1` was released the same day. The window below covers both patch releases relative to `v0.8.1`.

---

### v0.9.1 — 2026-09-28

#### Fixes

- **Settings**: Show Settings as a standalone full-page view when no session sidebar is present (#657)
- **Settings**: Larger reading type scale for all Settings pages (#663)
- **Settings**: Readable layout applied consistently across every Settings section (#664)
- **Settings**: Load all permission approvals in a single request; rework Permissions page (#659)
- **Sidebar**: Move "Share this session" into the per-session row menu (#660)
- **UI**: Inset the select chevron to avoid double-border flush on native `<select>` (#662)

#### Documentation

- README and npm description aligned with codekin.ai messaging (#661)
- Self-hosted relay documented as a first-class path (#658)

---

### v0.9.0 — 2026-09-28

#### Features

- **Settings full view** — Routed `/settings/<section>` replaces the modal; left nav + section content on desktop, list → detail on mobile (#651, #652, #654)
- **Hosted home** — When no machine is connected, `/settings` becomes the home screen; Profile and operator Accounts sections added (#654)
- **Two-factor authentication** — Full 2FA backend (TOTP + passkeys, enforcement policy, step-up) and matching UI (enrollment, recovery codes, settings) (#648, #649)
- **Workspace invitations** — Accept workspace invitations via GitHub sign-in (#647)
- **Workspace UI** — Workspace switcher, member list, roles, and machine oversight panel (#646)
- **Workspace backend** — Membership scoping, member management, role enforcement (#645)
- **Themes** — Nine colour themes: distinguish palettes, soften Matrix green (#653)

#### Fixes

- Relay session-isolation gaps from 2026-09-28 audit (#655)
- Hosted access hardening — Phase 0 (#644)

#### Documentation

- Security audit of hosted access, workspaces, invitations, and 2FA (#643)
- Hosted workspaces/MFA phases 0–3 marked deployed (#650)

---

### v0.8.1 — 2026-09-27 (included for context)

#### Features

- Theme selector with eight colour themes including Matrix (#638, #640)
- Focused first-run hosted setup, resumable machine setup, safe sign-in return (#636)

#### Fixes

- Persistent embedded connector, any-agent installer, pairing hygiene (#635)
- Local repo discovery without `gh`; truthful landing readiness (#634)
- `multer` bumped to 2.4.0 (high-severity advisories) (#630)
- Orchestrator outbox/manager module-init cycle (#628)
- Point-release model discovery (Fable 5.1, Opus 5.5) (#631)

#### Refactoring

- Removed unused `CODEX_MODELS` static list (#632)
- OpenCode SSE event dispatcher split from 305-line module (#629)

---

## Stale Branches

> **Note:** This repository uses squash-merge on GitHub, so `git branch --merged` cannot detect which branches have been squash-merged into `main`. The "Merged?" column is marked as "likely yes" for branches whose corresponding PRs were clearly completed based on commit messages and the commit log on `main`.

### Feature/Fix branches (> 30 days with no activity)

| Branch | Last commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | likely yes | Delete |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | likely yes | Delete |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | likely yes | Delete |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | likely yes | Delete |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | likely yes | Delete |
| `origin/fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | likely yes | Delete |
| `origin/fix/clone-test-ci-timeout` | 2026-06-11 | Claude (Webhook) | likely yes | Delete |
| `origin/fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | likely yes | Delete |
| `origin/fix/commit-event-handler-mock-missing-export` | 2026-04-27 | Claude (Webhook) | likely yes | Delete |
| `origin/fix/commit-event-handler-test-mock` | 2026-04-27 | Claude (Webhook) | likely yes | Delete |
| `origin/fix/eslint-test-config-unused-vars-and-require` | 2026-04-27 | Claude (Webhook) | likely yes | Delete |
| `origin/fix/security-commit-event-sanitization-2026-04-30` | 2026-04-30 | alari | likely yes | Delete |
| `origin/hosted-relay-control-plane-spec` | 2026-08-08 | alari76 | yes (plan superseded) | Delete |
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | likely yes | Delete |
| `origin/chore/release-0.6.4` | 2026-04-27 | Claude (Webhook) | yes | Delete |
| `origin/chore/release-0.7.1` | 2026-08-05 | alari | yes | Delete |
| `origin/docs/claude-code-integration-assessment` | 2026-06-11 | alari | yes | Delete |

### Automated audit branches (> 30 days)

26 `audit/` branches from April–May 2026 (daily code-review, security, repo-health, complexity, docs-audit runs). These are generated artefacts — the reports are preserved in commit history. All are candidates for bulk deletion.

---

## PR Hygiene

| PR# | Title | Author | Days open | Review status | Conflicts? | Stuck? |
|---|---|---|---|---|---|---|
| #666 | docs: compare Codekin with Conductor and prioritize improvements | alari76 | 1 | No review yet | No | No — too fresh |
| #626 | test(upload-routes): stub the gh subprocess in the clone regression test | alari76 | 28 | No review | **CONFLICTING** | **Yes** |

**PR #626** is the only stuck item. It's a test-only change (stubs the `gh` subprocess in the clone regression test) that has accumulated merge conflicts over 28 days. It is low-risk to rebase and merge, or alternatively close and re-open if the test strategy has changed.

---

## Merge Conflict Forecast

| Branch | Ahead of main | Behind main | Overlapping files | Risk |
|---|---|---|---|---|
| `origin/feat/conductor-comparison` | 1 | 3 | `.codekin/reports/product/2026-09-28_conductor-comparison.md` only | **Low** — new file, no content overlap |
| `origin/fix/settings-standalone-view` | 0 | 0 | — | **None** — current branch is at v0.9.0, same as HEAD tracked by this worktree |
| `origin/chore/release-0.9.1` | 9 | 0 | — | **None** — already merged (squash) into `origin/main` |

No high-risk branches with overlapping file changes were detected. `feat/conductor-comparison` (PR #666) is the only active feature branch; it touches a single new report file and will rebase cleanly.

---

## Recommendations

1. **Delete stale feature/fix branches (impact: medium)** — 17 old feature and fix branches from April–August 2026 are accumulating on the remote. Run `git push origin --delete <branch>` for each, or use `gh api` to batch-delete. Reduces noise in `git branch -r` and PR dropdowns.

2. **Bulk-delete automated audit branches (impact: low, hygiene: high)** — 26 `audit/*` branches older than 30 days should be cleared. The reports are safely in commit history. Consider configuring the audit automation to delete its branch after the PR merges.

3. **Rebase or close PR #626 (impact: medium)** — The upload-routes clone test stub has been conflicting for 28 days. Either rebase it onto `main` (small change, should be fast) or close it if the approach is outdated. Leaving a conflicting PR open longer risks further drift.

4. **Remove `src/components/settings/SectionCard.tsx` (impact: low)** — The file exports `SectionCard` but is never imported anywhere. It was likely created during the settings refactor (#651) and then superseded. If no immediate use is planned, delete it to avoid confusion.

5. **Add a Prettier config (impact: low, consistency: high)** — There is no `.prettierrc` or `prettier.config.*`. Adding a minimal shared config (e.g., `{ "singleQuote": true, "semi": false, "printWidth": 100 }`) prevents format churn and makes editor integration consistent across contributors.

6. **Audit `docs/API-REFERENCE.md` against new Settings endpoints (impact: medium)** — The bulk `/api/approvals` endpoint and new Settings-section REST routes added in PRs #651–#654 and #659 may not be reflected in the API reference. A focused doc pass would keep the spec authoritative.

7. **Promote warning-level ESLint rules to errors (impact: low/ongoing)** — `no-non-null-assertion`, `restrict-template-expressions`, `require-await`, and `no-misused-promises` are all demoted to warnings pending incremental cleanup. Opening a tracking issue or PR to clear these one section at a time would progressively strengthen the type safety floor.

8. **Verify SPDX license fields for `busboy` and `streamsearch` (impact: negligible)** — Both are MIT but lack the `license` field in their `package.json`. No action required unless a licence-checker tool is introduced; if one is, add these to the allow-list.