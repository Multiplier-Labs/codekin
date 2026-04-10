# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.5] - 2026-04-10

### Fixes
- Enforce report file output in CLAUDE.md instructions (#317)
- Respect permission mode for file tool auto-approval in hook (#316)
- Strip uninformative agent noise lines from chat display (#313)
- Address three security audit findings (M1, M2, W-2/L4) (#311)
- Strip GIT_* env vars when spawning Claude CLI processes (#307)
- Prevent branch deletion on caller-supplied names, use show-ref for detection
- Prevent worktree restart death loops with CWD validation (#305)
- Prevent broken worktree directories from causing infinite restart loops (#304)
- Preserve claudeSessionId on spawn failures (ENOENT) (#302)
- Resolve session restart race conditions and worktree index corruption (#301)
- Security, reliability, and housekeeping fixes (#298)

### Refactoring
- Extract session lifecycle into session-lifecycle.ts (#308)
- Extract PromptRouter from SessionManager (#303)

### Tests
- Add unit tests for session restart and worktree fixes (#306)

### Chores
- Housekeeping — fix contradictory comments, prune stale branches (#315)
- Remove dead orchestrator API functions and fix CORS_ORIGIN doc (#312)

### Documentation
- Fix stale paths, env vars, and remove non-existent endpoints (#300)

## [0.5.4] - 2026-04-06

### Features
- Support subscription/OAuth auth in addition to API key auth (#283)

### Fixes
- Fall back to fresh session when `--resume` hangs with zero output (#292)
- Stabilize Claude process lifecycle to prevent restart loops (#290)
- Resolve restart loop caused by race condition in `startClaude()` (#288)
- Exempt agent/orchestrator sessions from idle reaper and stale pruner
- Unblock standalone CLI sessions when `CODEKIN_SESSION_ID` is missing (#283)
- Remove dead export, fix docs drift, add logging to silent catches (#294)
- Address code review findings and stale docs (April 5 audit)

### Security
- Address 3 security audit warnings (W-01, W-02, W-03)
- Address 5 code review findings (W-02, W-03, W-04, W-09, I-09) (#282)

### Documentation
- Update API reference, orchestrator spec, and protocol docs

## [0.5.3] - 2026-04-03

### Fixes
- Overhaul approvals architecture for parity with native CLI (#280)
- Route ExitPlanMode through server's `requestToolApproval()` for correct PlanManager state transitions
- Make git push patternable so "Always Allow" creates a `git push *` pattern
- Unify approval timeout to 300s (5 min) for all session types
- Deny with clear error when `CODEKIN_SESSION_ID` is missing instead of silently hanging
- Pass ExitPlanMode rejection reason through to hook response

## [0.5.2] - 2026-04-03

### Features
- Add `--dangerously-skip-permissions` as a permission mode setting for sandboxed environments (#277)

### Fixes
- Resolve Agent Joe passivity issue (#273)
- Improve long session stability and resource management (#272)
- Pass `CODEKIN_SKIP_PERMISSIONS` env to hooks for dangerouslySkipPermissions mode
- Address security and code review findings
- Resolve 3 ESLint errors breaking CI

### Security
- Upgrade lodash to 4.18.1 to resolve high-severity audit vulnerabilities

### Refactoring
- Reduce code complexity across 6 high-priority areas (#267)

### Documentation
- Fix documentation issues from weekly audit

### Chores
- Upgrade TypeScript 6, Vite 8, ESLint 10, jsdom 29
- Improve dependency health per 2026-03-31 audit
- Improve code coverage across server and frontend modules (#265)
- Add repo health, security audit, and code commenting reports

## [0.5.1] - 2026-03-28

### Features
- Add actor allowlist filter for webhook events (#261)

### Fixes
- Fix archived sessions not showing worktree-based manual sessions (#264)
- Add context size management to GPT and Gemini review tools (#262)
- Enforce plan mode gating via hook + PlanManager state machine (#258)
- Use deny-with-message pattern for ExitPlanMode hook approval (#255)
- Improve orchestrator empty state layout (#254)
- Resolve listener leak, type-unsafe mutations, and wrong path in orchestrator (#253)
- Show stall warning only once until new user input (#252)
- Suppress repetitive orchestrator noise in chat (#251)
- Remove stall timer warning from orchestrator chat (#256)

### Refactoring
- Replace distributed plan mode flags with PlanManager state machine (#257)

### Documentation
- Improve code comments per comment assessment audit (#260)

## [0.5.0] - 2026-03-23

### Features
- **Agent Joe orchestrator** — AI agent that spawns and manages up to 5 concurrent child sessions, with dedicated chat UI, welcome screen, resizable input, color-coded sidebar status icons with tooltips, and configurable agent name
- **Git worktree support** — isolate sessions in dedicated worktree directories with mid-session creation, worktree name indicator in input toolbar, auto-enable setting, and full session context preservation across migrations
- **Permission mode selector** — dropdown in input bar to choose between permission modes
- **Per-session allowed tools** — pre-approve specific CLI tools for individual sessions; curl pre-approved for Agent Joe and child sessions
- **Upgrade notifications** — in-app banner when a newer npm version is available, plus `codekin upgrade` CLI command
- **Configurable message queueing** — optional queued message system as a setting (off by default)
- **Sidebar session status tooltips** — hover tooltips on session status indicators
- **Settings view improvements** — reorganized layout with better consistency
- **Session lifecycle hooks** — orchestrator approval endpoints for child session management
- **Dual-write approvals** — approval rules written to both Codekin and native `settings.local.json` for Claude CLI compatibility

### Fixes
- Fix ExitPlanMode double-approval, timeout-denial, and stuck-state bugs
- Fix AskUserQuestion handling: route through PreToolUse hook, properly extract questions/options, format answers correctly
- Save exact commands when "Always Allow" clicked for non-patternable commands
- Prevent restart cascade from stale session ID reuse
- Prevent session restore restart loop after server restart
- Fix Agent Joe child sessions not appearing in sidebar
- Prevent double-gating race in orchestrator respond endpoint
- Don't mark child session completed while tool approvals are pending
- Use `--resume` instead of `--session-id` when restarting Claude sessions
- Inject conversation context when Claude restarts after crash
- Key approval rules by repo root, not worktree path
- Clean up worktrees on session delete; prevent new sessions from inheriting worktree paths
- Strip inherited `GIT_*` env vars from child git processes
- Harden worktree creation against stale dirs and subdirectory cwd
- Fix SPA fallback with styled 404/500 error pages
- Fall back to control_request when permission hook can't reach server
- Fix sidebar menu highlight contrast and consistency
- Anchor skills popup to right edge to prevent viewport overflow
- Prevent CLI error messages from becoming session names
- Format API error messages instead of showing raw JSON
- Use gray color for orchestrator approval/denial messages
- Increase font size for AskUserQuestion prompts
- Polish orchestrator chat view (resizable input, remove clutter)

### Security
- Harden SQLite file permissions and shell JSON escaping
- Fix symlink traversal in browse-dirs path check
- Harden orchestrator path guards and sanitize branchName input
- Update flatted to resolve high-severity prototype pollution vulnerability
- Address critical and major findings from code review audits
- Fix SIGKILL timer leak, stale closure, silent approval escalation, unbounded file reads

### Refactoring
- Rename Shepherd to Agent Joe / orchestrator throughout codebase
- Extract DiffManager class and break up App.tsx into focused components
- Make prompt queue session-scoped
- Replace AI SDK with `claude -p` for session naming (removes AI SDK dependency)
- Extract DiffManager and RestartScheduler from SessionManager
- Reorganize input bar footer layout

### Documentation
- Add Shepherd/orchestrator session spec
- Implement comment audit improvements across 11 files
- Remove stale AI SDK references from docs

### Chores
- Add comprehensive diff-parser tests (coverage from ~1% to 98%)
- Fix code coverage gaps from March 16 coverage audit
- Add automated repo health and code review reports

## [0.4.1] - 2026-03-16

### Fixes
- Implement critical and warning findings from code review audit

### Chores
- Improve code coverage for diff-parser, approval-manager, usePromptState, ccApi

## [0.4.0] - 2026-03-14

### Features
- Add commit-review event dispatcher for event-driven workflow triggers
- Add commit-review workflow definition and UI kind
- Add cross-repo auto-approval inference
- Implement diff viewer sidebar for browsing session file changes
- Add inline slash command autocomplete and fix command routing
- Add configurable repos path setting for locally cloned repositories
- Add Code Review button to chat area when files are modified
- Implement approval system fixes (prompt queue, requestId matching, pattern-first storage, hook denial surfacing)
- Add repositories path setting to empty state view
- Add folder picker with path validation for repos path setting

### Fixes
- Fix file uploads: add markdown support, increase size limit, improve errors
- Use `path.extname()` for safer file extension extraction
- Upload files immediately when message is withheld
- Chunk git path args in discard to avoid E2BIG on large repos
- Fix missing approval prompts for WebSearch, WebFetch, and other tools
- Fix AskUserQuestion handling: fallback for malformed input, preserve option values
- Fix stale cron schedules and decouple commit-event auth
- Fix security issues from code review audit
- Fix Code Review button contrast in light mode
- Improve diff panel UX: global scroll, darker bg, lighter light-mode diffs
- Fix task popup overlapping diff view button and rename to Diff view
- Update DiffToolbar background color

### Security
- Fix security and correctness issues from GPT review
- Implement repo health audit fixes

### Documentation
- Add documentation from code comment audit
- Add approvals system fix spec

### Chores
- Remove obsolete `.codekin/outputs/` directory
- Remove orphan components `SessionList.tsx` and `SessionListPanel.tsx`

## [0.3.7] - 2026-03-11

### Features
- Add weekly Claude Code usage limit percentage to sidebar
- Add codekin.ai website link to README
- Add missing features to README and screenshot

### Fixes
- Fix webhook/stepflow sessions creating duplicate repo entries in sidebar
- Fix docs browser auth, suppress duplicate model messages, and auto-focus repo search
- Fix security and robustness issues from code review audit
- Reduce frontend complexity per complexity report findings
- Remove usage limit feature (`rate_limit_event` lacks usage percentage)
- Adjust sidebar bottom toolbar for mobile responsiveness
- Fix missing imports for `execFile` and `homedir` in session-manager

### Chores
- Implement repo health audit improvements
- Remove `GH_ORG` from README config table
- Gitignore PM2 ecosystem config and rename log path to codekin

## [0.3.6] - 2026-03-10

### Features
- Auto-detect GitHub orgs from `gh` CLI when `GH_ORG` is not configured
- Add GitHub org auto-detection to the setup/config wizard UI

### Fixes
- Remove GitHub org prompt from setup wizard (the org is now auto-detected)

## [0.3.5] - 2026-03-10

### Fixes
- Inject `PATH` and `HOME` into launchd plist for macOS service (gh CLI access)

## [0.3.4] - 2026-03-10

### Fixes
- Show helpful message when GitHub CLI (`gh`) is not installed

### Chores
- Add `codekin uninstall` command
- Add `codekin config` command to update API keys
- Add GitHub CLI auth check to installer
- Suppress npm deprecation warnings during install
- Add config and uninstall commands to README usage section

## [0.3.3] - 2026-03-10

### Chores
- Replace `react-syntax-highlighter` with shared `highlight.js` instance (bundle size reduction)
- Upgrade: express 4→5, multer 1→2, `@types/node` 24→25, drop `@types/dompurify`
- Fix `no-floating-promises` ESLint violations across frontend and server
- Add server `@types/*` to root devDependencies for CI build

## [0.3.2] - 2026-03-10

### Fixes
- Fix installer breaking when piped through `curl | bash`
- Shorten auth token from 64 to 22 characters
- Add server runtime deps to root `package.json` for global install
- Update install URL to `codekin.ai/install.sh` in README

## [0.3.1] - 2026-03-09

### Features
- Add image display support for tool results in chat

### Fixes
- Fix external images not rendering due to CSP
- Fix images hidden inside collapsed tool activity section
- Fix queued messages losing attached files on execute
- Persist images to session history for replay on session switch
- Read auth token from URL query parameter on initial load
- Add missing `image` variant to server `WsServerMessage` type
- Add mobile-responsive layout with sidebar drawer, top bar, and adaptive modals
- Improve mobile header alignment with fixed height and uniform button sizing
- Fix mobile layout issues: scrollbar, input height, sidebar close
- Fix mobile UX: prevent keyboard popup on approval dialogs, enlarge tap targets
- Fix mobile menu not closing when tapping content area
- Bump mobile icon sizes to 24px per Material Design standard
- Darken sidebar background and text for repo names, icons, and AI Workflows button
- Soften dark mode contrast: darker input bar, uniform text color

## [0.3.0] - 2026-03-09

### Features
- Docs browser: in-app markdown docs viewer with inline file picker,
  keyboard navigation, inverted header, and star/favourite persistence
- Workflow model selection: optional `model` frontmatter field; model badge in workflow list
- GitHub Webhooks section in Settings panel
- Repository Health built-in workflow type
- Custom TimePicker component replacing native browser time input; bi-weekly frequency toggle

### Fixes
- Fix workflow panel contrast in light mode
- Fix docs icon toggle (clicking again closes the picker)
- Fix sidebar timestamp vertical alignment
- Fix docs file picker not appearing on sidebar icon click
- Fix docs API: switch from path params to query params
- Fix sidebar session name bold and workflow list alignment
- Fix sidebar repo ordering (alphabetical)
- Fix workflow validate_repo failing when REPOS_ROOT is a symlink
- Fix Settings font sizes and light mode contrast
- Remove tracked dist/ files causing stale asset references
- Fix CI: restore better-sqlite3 as root devDependency
- Add missing auth variant to server WsClientMessage type

### Security
- Implement critical code review audit findings (H1–H3, M1–M6, L1–L4)
- Implement critical dependency audit findings

### Refactoring
- Reduce complexity across 7 modules per complexity audit
- Refine SessionManager split; complete delegation to extracted modules
- Improve Settings modal layout with section cards

### Documentation
- Add JSDoc and inline comments per comment audit
- Add docs browser implementation spec

### Chores
- Add 50 new tests from coverage audit
- Bump version to 0.3.0

## [0.2.2] - 2026-03-08

### Features
- Redesign workflow view: unified cards, multi-step wizard, cleaner edit
- Group workflow list by repo with compact rows and hover actions
- Sidebar: add Active sessions label and session count on collapsed repos
- Extract shared RepoList component with search filtering
- Wire up dynamic workflow kinds: API endpoint, frontend fetching, and repo registration
- Add repo workflow discovery and kind listing APIs
- Commit workflow reports to dedicated branch and push to remote

### Fixes
- Fix empty repo list in AddWorkflowModal by passing auth token to useRepos
- Show error message in AddWorkflowModal when repo fetch fails
- Fix shell injection in workflow-loader and move better-sqlite3 to deps
- Improve contrast of remote badge in RepoList
- Increase contrast on repo group boxes in workflow list

### Security
- Harden server: SSRF protection, input validation, security headers
- Add auth check to hook-notify endpoint

### Documentation
- Document custom repo workflow definitions in WORKFLOWS.md

### Chores
- Remove session name field from new-session dropdown
- Remove manual refresh button from workflows view
- Add workflow-loader tests covering MD parsing, step handlers, and cleanup

## [0.2.1] - 2026-03-08

### Fixes
- Fix silent errors on workflow trigger/cancel actions
- Fix workflow loader not finding MD definitions when running from dist/

### Chores
- Remove local deploy/ops scripts from repo

## [0.2.0] - 2026-03-08

### Chores
- First open source release
- Bump version to 0.2.0

## [0.1.8] - 2026-03-08

### Chores
- Initial release

## [0.1.7] - 2026-03-08

### Added

- Initial public release
- Multi-session support with WebSocket streaming
- Slash-command skills (`/validate-gemini`, `/validate-gpt`)
- Session auto-naming via Groq (Llama 4 Scout)
- File upload support
- React frontend with TailwindCSS 4
- npm package with `codekin` CLI entry point
