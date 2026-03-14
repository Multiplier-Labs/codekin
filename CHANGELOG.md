# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Add docs/DOCS-BROWSER-SPEC.md

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
