# Codekin

Web-based terminal UI for Claude Code sessions with multi-session support, WebSocket streaming, and slash-command skills.

## Development

```bash
npm install          # install dependencies
npm run dev          # start Vite dev server
npm run build        # typecheck + production build
npm test             # run tests once
npm run test:watch   # watch mode
npm run lint         # eslint
```

## Branching & Release Policy

- **NEVER commit or push directly to `main`.** Always create a feature/fix branch and open a PR.
- Branch naming: `feat/description` or `fix/description`.
- All changes go through PRs with review and passing CI.
- Releases are tagged with semver: `v0.2.0`, `v1.0.0`, etc.

## Bash Tool Conventions (Skills & Subagents)

- **One command per Bash call** — do NOT chain with `;`, `&&`, `||`, or pipes
- **Do NOT use `echo` to inspect exit codes** — the Bash tool returns them automatically
- **Do NOT use `cat` to read files** — use the Read tool instead
- These rules prevent multi-operation approval prompts in the Codekin terminal UI

## Output Conventions

- Always use fenced code blocks (` ```language `) for code/config snippets — they render properly in the terminal UI
- Never rely on tool output alone to show file contents — paste in a code block if the user needs to see it

## Key Conventions

- TypeScript strict mode for server code
- WebSocket message types defined in `src/types.ts` (shared between client and server)
- Monospace font: Inconsolata; Sans font: Lato

## References

- See `docs/architecture.md` for module map, data flow, and key abstractions.
- See `docs/conventions.md` for coding patterns and file organization.
- See `docs/WORKFLOWS.md` for automated workflow system.
- See `docs/API-REFERENCE.md` for REST and WebSocket API.
