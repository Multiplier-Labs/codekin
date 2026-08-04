# Codekin

Web-based terminal UI for Claude Code sessions with multi-session support, WebSocket streaming, and slash-command skills.

## Architecture

- **Frontend**: React + Vite + TailwindCSS 4
- **WebSocket server**: Node.js + Express + ws, runs on port 32352 (configurable)
- **Claude CLI**: Spawned per-session with `--output-format stream-json --input-format stream-json`

## Development

```bash
npm install          # install dependencies
npm run dev          # start Vite dev server
npm run build        # typecheck + production build
npm test             # run tests once
npm run test:watch   # watch mode
npm run lint         # eslint
```

## Key Directories

- `src/` — React frontend source
- `src/components/` — UI components (ChatView, InputBar, RepoSelector, etc.)
- `src/hooks/` — WebSocket and session hooks
- `server/` — WebSocket server, Claude process manager, session manager
- `docs/` — Protocol and setup documentation

## Coding Conventions

- TypeScript strict mode for server code
- Frontend uses TailwindCSS utility classes with custom color theme defined in `src/index.css`
- WebSocket message types defined in `src/types.ts` (shared between client and server)
- Monospace font: Inconsolata; Sans font: Lato

## Styling Rules

The visual system is token-driven; an ESLint guard enforces most of this in `src/components`.

- **Semantic color tokens only** in components: `bg-page` / `bg-surface` / `bg-surface-raised`,
  `border-edge` / `border-edge-strong`, `text-ink` / `text-ink-muted` / `text-ink-faint` /
  `text-ink-inverse`, `focus:border-focus`. Never raw `*-neutral-N` steps or Tailwind's default
  palette (`purple-400`, `text-white`, …). Intent families (`primary`, `secondary`, `accent`,
  `error`, `warning`, `success`) are used directly for status color.
- **Five type steps**, nothing else: `text-micro` (11px), `text-meta` (12.5px), `text-body`
  (14.5px), `text-title` (17px), `text-head` (22px). Line-height is bound to each step. No
  arbitrary `text-[Npx]` (single sanctioned exception: the 16px mobile composer textarea in
  `InputBar.tsx`, which prevents iOS zoom-on-focus).
- **Three surfaces**: level 0 page (transcript ground), level 1 `bg-surface` + `border-edge`
  (sidebar, panels, cards), level 2 `bg-surface-raised` + `border-edge-strong` + `shadow-floating`
  (modals, popovers, palette). `shadow-floating` is the only shadow. Radii: `rounded-control` for
  buttons/inputs/rows/badges, `rounded-floating` for modals/popovers, `rounded-full` only for
  circles (dots, avatars).
- **Density via tokens**, not per-element `isMobile` ternaries: rows read `var(--row-h)`,
  `var(--row-pad)`, `var(--icon-size)`; touch mode is set once via `data-density="touch"` on the
  app shell.
- Both theme polarities (`[data-theme="dark"]`, `[data-theme="light"]`) and the `.terminal-area`
  scope must be checked when changing colors.

## Branching & Release Policy

- **NEVER commit or push directly to `main`.** Always create a feature/fix branch and open a PR.
- When committing changes, first create a branch using `feat/description` or `fix/description` naming.
- When asked to push, push the feature branch and create a PR — do NOT push to `main`.
- All changes go through PRs with review and passing CI.
- Releases are tagged with semver: `v0.2.0`, `v1.0.0`, etc.

## Audit & Report Output

When generating audit reports, health checks, or any recurring assessment:

1. **Always write the report to a file** — never just print it as conversation text.
2. **Location**: `.codekin/reports/<category>/YYYY-MM-DD_<type>.md` (e.g., `.codekin/reports/security/2026-04-10_security-audit.md`).
3. **Existing categories**: `code-review`, `comments`, `complexity`, `dependencies`, `docs-audit`, `repo-health`, `security`, `test-coverage`. Create new subdirectories if needed.
4. **Clean output only** — do not include internal reasoning, chain-of-thought, or status messages (e.g., "Now I have the data...") in the report file. The file should contain only the finished report.
5. **Commit the report** on a branch and open a PR so it is visible in the repo history.

## Output Conventions

- When sharing code snippets, configuration files, or file contents with the user, always use fenced code blocks (```language) so they render properly in the terminal UI
- Never rely on tool output alone to show file contents — if the user needs to see it, paste it in a code block in your response
