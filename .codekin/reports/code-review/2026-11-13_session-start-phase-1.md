# Phase 1 session-start review

Reviewed PRs #857–#864, range `4d9dd8a..c184f15`, at merged head `c184f15`.

**Result: changes requested before release.** The normal start flow has substantial test coverage, but four reproduced edge cases need fixes. This PR proposes fixes; it does not change application behavior.

## Findings

### 1. P1 — New sessions inherit the last joined session's permission mode

Location: `src/App.tsx:622–624`, composer props at `1169–1171`.

Reproduction: save `acceptEdits` as the new-session preference, join a session running with `bypassPermissions`, then open New and send. `session_joined` updates `currentPermissionMode` without changing the preference. Leaving the session does not reset that state. The new composer displays and sends `currentPermissionMode`, so the next session starts with Bypass despite the saved default. The previous creation flow used `permissionModeRef.current`, which reads the preference instead. The mode is visible in the composer, but merely visiting another session should not change the intended default.

Evidence: a hook probe joined a Bypass session and left it; `getPref('permissionMode')` remained `acceptEdits`, while `currentPermissionMode` remained `bypassPermissions`. App passes the latter directly into `startDraftSession`.

Proposed fix: give the draft its own permission state, initialized from the saved new-session preference and normalized with `draftModeFor` for its provider. Use that state for both the displayed selection and creation payload. Keep draft choices independent of joined-session state and WebSocket mutation callbacks. Respect an explicitly edited draft across navigation.

Regression test: mount the application with a safer saved default, visit a Bypass session, open New, and assert both the displayed mode and `create_session.permissionMode` use the saved default. Also cover Claude-only Skip when the default provider is another agent.

### 2. P2 — Upload, clone and scratch-creation failures erase the first prompt

Location: `src/App.tsx:636–640`; interaction with `src/components/InputBar.tsx:832–840`.

Reproduction: type a first prompt and make an upload, clone or scratch creation request fail before `create_session`. `handleDraftSend` initially saves the text, but InputBar immediately calls `onValueChange('')` after `onSendInput`. That second update clears `draftText`. The asynchronous catch then remounts InputBar without restoring the submitted text, leaving an empty composer and an error. The WebSocket-error path restores `draft.text`; the earlier HTTP-error path does not.

Evidence: the real NewSessionComposer/InputBar mounted in a small state harness matching App's callback wiring showed the setup error and an empty textarea after rejection. This was a component/state reproduction, not a full browser/API reproduction.

Proposed fix: immediately restore the captured `text` in the catch before incrementing `draftResetKey`. Prefer retaining the full draft until creation succeeds so there is one recovery path for text, attachments and resolved place. Track the operation from the start of upload/clone, not only after the WebSocket request, to make retries and navigation predictable.

Regression tests: reject each of upload, clone and scratch creation; assert the exact prompt and attachments remain and retry sends the original content once.

### 3. P2 — A folder inside a Git repository is treated as having no Git

Location: `server/places.ts:208–224`; consumers include the picker, worktree creation guard and git-init endpoint.

Reproduction: initialize `repo`, create `repo/src`, and select `repo/src` as the session's folder. Git reports `rev-parse --is-inside-work-tree` as `true`, but `detectPlace(repo/src)` returns `{ kind: 'folder', git: false }` because only an immediate `.git` entry is checked. This hides Changes and worktree controls, and offers Initialize git here for a folder already belonging to a repository. Accepting that action creates a nested repository rather than using the existing repository.

Evidence: a temporary real Git repository probe compared Git's result with `detectPlace` and reproduced the disagreement.

Proposed fix: use a shared, cached repository-discovery helper that recognizes ancestor repositories and linked worktrees. Return the repository root separately from the user's selected working directory. Preserve the selected subdirectory for session execution, and define how that relative path maps into an isolated worktree. The git-init endpoint must independently refuse initialization when Git already recognizes an enclosing worktree.

Regression tests: repository root, nested folder, linked-worktree nested folder, genuine non-Git folder, and git-init refusal in an existing repository's child directory.

### 4. P2 — Default scratch-path rejection happens after an out-of-bounds write

Location: `server/places.ts:120` and `152–156`.

Reproduction: make `~/codekin` a symlink to an existing writable directory outside both allowed roots, with no `scratch` child yet. `getScratchRoot()` resolves the default through that symlink without applying `validateScratchRoot`. `createScratchDir` recursively creates the outside `scratch` directory, then checks the real path and throws. The request fails, but the filesystem mutation has already happened outside the documented bounds.

Evidence: an isolated temporary-home probe confirmed that `createScratchDir()` throws the bounds error and the outside `scratch` directory nevertheless exists afterward. No session is successfully created by this reproduction; this is a pre-validation write, not a demonstrated arbitrary-file overwrite.

Proposed fix: validate every effective root, including the default and the explicit `createScratchDir` argument, before `mkdirSync`. Retain the post-creation realpath check as defense against path changes. If the default resolves outside the permitted roots, fail without creating directories and show a useful configuration error.

Regression test: the symlink scenario must reject and leave the outside directory unchanged. Also cover invalid configured roots falling back to an invalid default.

## Validation

- Targeted existing coverage: **337 tests passed across 13 files** (places, picker, composer, folder browser, router, draft start, sidebar section, diff panel, session routes, WebSocket handler and relay proxy).
- Full existing suite: **5,230 tests passed across 299 files**. The two load-related failures described in the handoff did not recur in this run; this does not establish that they are fixed.
- ESLint: **0 errors, 630 warnings**, matching the warning count recorded in the handoff.
- Production build: **passed**, with the existing bundle-size warning.
- Four temporary review probes reproduced the observations above; their copied suites passed **97 tests**. These asserted observed behavior to confirm the findings, not correctness. They were removed from the working tree afterward.
- No fresh browser walkthrough or deployed-service validation was performed. This review covers source, automated tests, a real Git fixture and component/hook probes.
- The earlier smoke-test preferences HTTP 400 was not reproduced or attributed to a specific defect. The new `recentPlaces` key satisfies the preferences route's key validation; further diagnosis needs the failed request payload/response.

## Proposed implementation order

1. Separate draft permission state and fix prompt recovery, with application-level tests across session-to-composer transitions.
2. Correct repository discovery and protect git-init against nested initialization.
3. Validate the default scratch path before creating directories.
4. Repeat a browser walkthrough covering failed Send/retry, switching from an existing session, nested repository folders, and mobile options.

No application fixes, releases, deployments or service restarts were performed in this review.
