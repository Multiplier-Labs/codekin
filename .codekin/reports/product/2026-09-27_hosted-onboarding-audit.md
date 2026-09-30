# Hosted Codekin: new-user experience audit

Date: 2026-09-27. Intended journey: hosted web app → connect the user's local Codekin instance → open an existing repository → get the first useful agent response.

## Assessment

The journey has functional gaps before the first coding session, not just rough presentation. A technically capable user can get through with terminal knowledge, manual reloads, and familiarity with Codekin's architecture. The product currently relies on that knowledge at exactly the points where a new user does not have it.

There are useful foundations: account sign-in, generated pairing commands, remembered machines, connection preflight and retry, an environment checklist, health-filtered provider pickers in the sidebar, folder browsing, and inline clone failures. The highest-value work is joining these into a reliable setup flow.

## Relationship to the 2026-08-29 audit

[`2026-08-29_nux-automation-audit.md`](2026-08-29_nux-automation-audit.md) (Part 1) covered the same funnel a month earlier. Progress since then, and what carries over:

| 2026-08-29 recommendation | Status now | This report |
|---|---|---|
| N1 onboarding checklist from environment health | Shipped (`src/lib/environmentChecklist.ts`); misreports `gh` auth failures | N6 |
| N2 provider pickers filtered by availability | Shipped for sidebar/repo-row pickers; landing-page repo click still defaults to Claude | N6 |
| N4 `install.sh --pair` one-command install | Shipped (`install.sh:126-134`) | — |
| N4 installer requires *any* agent, not Claude | **Not done** — `check_claude` still hard-exits | N5 (carry-over) |
| N5 connector wires itself; one command brings machine online | **Not done** — connector is a separate foreground command | N1 (carry-over) |
| N5 README/site lead with hosted path | **Not done** | N8 (carry-over) |
| N5 request-access / approval path for non-allowlisted users | Changed: non-allowlisted identities are now rejected at login (no Pending row); still no request-access path | N8 |

The carry-overs are the main reason N1 and N5 stay at P1: both were identified as funnel blockers last month and are still open.

## Evidence and limits

- Reviewed checkout `594fc75b072dc1705ea20b0ed700435e1e8ddd7c`. Its two commits above `origin/main` (`fbcc9dc`) change only the Grok specification; audited runtime code is the same.
- Inspected the live [marketing site](https://codekin.ai/) and the live [hosted sign-in screen](https://app.codekin.ai/). Did not authenticate to production or create production accounts, machines, or sessions.
- Built hosted mode and exercised the production frontend bundle locally in Chromium at 1280×900 and 390×844. Account, machine, pairing-token, and passkey API responses were mocked. These checks validate frontend behavior, not deployment or end-to-end connectivity.
- Reproduced precreated orphan machines with the real pairing functions and an in-memory database.
- Traced installer, service, authentication, repository discovery, and session-creation code. Did not execute the installer on a clean Mac/Linux machine, test OS service persistence, or run a real agent conversation.
- Hosted Vite build succeeded. Six existing focused test files passed: 62 tests across machines, environment checklist, session orchestration, pairing, and relay auth. Passing unit tests do not cover the complete onboarding journey.
- Every claim below was independently re-verified against source in a second pass; corrections from that pass are folded in.

Source links below use the reviewed revision. P1 means an activation or recovery blocker for the stated cohort; P2 means significant confusion or avoidable friction. These priorities are qualitative, not measured conversion impact.

## Findings

### N1 · P1 · Installation does not leave a hosted machine online

**User experience:** Copy the generated installer, complete installation, and return to the browser. The local server runs as a service, but the relay connector does not. The user must notice terminal output and separately run `codekin relay connect`, which stays in the foreground. Closing that terminal stops the connector; the installed server service does not restart it.

**Evidence:** [installer pairing and completion](https://github.com/Multiplier-Labs/codekin/blob/594fc75/install.sh#L139) only runs `codekin relay login`, then prints “Bring it online with: codekin relay connect”. [Foreground connector command](https://github.com/Multiplier-Labs/codekin/blob/594fc75/bin/codekin.mjs#L256) uses `spawnSync(…, stdio: 'inherit')`; [connector-cli](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/relay/connector-cli.ts#L1) documents “runs the connector in the foreground until Ctrl-C”. `codekin service install` generates systemd/launchd units for the server script only (`bin/codekin.mjs:371-392`, `465-473`); `docs/OPERATIONS.md` tells operators to run the connector under pm2. Pairing failure is caught as a `warn` (`install.sh:146-148`) and the script still prints “Installation complete!” and points to `codekin token`, the local-access path (`install.sh:170-171`).

Re-running the installer on an already-paired machine always hits this failure branch: `codekin relay login` exits 1 with “Already paired” (`bin/codekin.mjs:153-157`), and the installer tells the user to “generate a fresh install command” — which will fail the same way.

**Change:** Make the hosted installer install/start a persistent connector alongside the server (a second unit, or have the server supervise the connector when a relay credential exists), verify hosted reachability, and finish with “Your machine is online; return to Codekin.” Distinguish local installation success from pairing or connection failure. Treat “already paired” as success (or offer re-pair). Explain that the computer must remain awake and online.

**Acceptance:** After one successful installation, the hosted page detects the machine without another command. Closing the installation terminal and rebooting preserve connectivity through the managed service. Failed pairing never produces an unqualified hosted-setup success message. Re-running the installer on a paired machine is idempotent.

### N2 · P1 · Command generation can strand users after a reload

**User experience:** Generate an install command, get interrupted, then reload. The generator is gone and an offline “Unnamed machine” can be left behind. The UI offers neither a replacement command nor removal of that record. This also prevents adding a second machine through the generator once any machine exists, including one shared with the user.

**Evidence:** [approvePairing](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/relay/pairing.ts#L118), called from `precreatePairing` (`pairing.ts:160`), inserts an `offline` “Unnamed machine” row before the installer claims it. [MachinesSection](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/MachinesSection.tsx#L54) renders `InstallCommand` only when `machines.length === 0`. In-memory reproduction: command generation produced `{ name: 'Unnamed machine', status: 'offline' }`; after forcing expiry, claim returned `expired` and the machine count remained 1. Nothing in `server/relay` sweeps expired unclaimed machines. Browser verification confirmed the generator disappears for a nonempty list (evidence 02).

Removal exists server-side but is unreachable: `DELETE /api/machines/:machineId` (`pairing-routes.ts:140`, owner-only) is never called by the frontend (`src/hosted/machines.ts` only lists and precreates), yet `codekin relay logout` tells users to “remove it in the hosted UI (Machines page)”.

Each “generate a new one” click creates another orphan row without revoking the previous token. `/pair/precreate` is not rate-limited (`relay-server.ts:81-84` covers only `/api/auth`, `pair/start`, `pair/complete`) and, unlike approve, records no audit event.

**Change:** Keep “Add computer” available regardless of machine count. Represent unfinished setup explicitly, with resume/regenerate/cancel. Create the permanent machine on claim (preferred) or sweep unclaimed rows after expiry; regenerating should revoke the previous pending token. Wire a Remove action to the existing delete endpoint. Rate-limit and audit precreate.

**Acceptance:** Generate → reload → expire → resume works entirely through the UI. An existing or shared machine never removes the ability to add another. Repeated regeneration leaves at most one pending record. An owner can remove a machine from the UI.

### N3 · P1 · The setup page does not observe progress or recover from list failure

**User experience:** A machine can pair and come online while the page still says “No machines paired yet.” A transient machine-list failure leaves only an error sentence, without Retry.

**Evidence:** [MachinesSection's mount-only fetch](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/MachinesSection.tsx#L35) (`useEffect(…, [])`). In Chromium, changing the mocked backend from empty to online produced **zero additional requests over 5.5 seconds** and the empty state remained. There is no timer, focus/visibility refresh, or explicit refresh control. A mocked 503 displayed the error with no retry action.

The pattern already exists next door: `DevicesSection.tsx:53-62` polls every 2 s while a QR device link is pending.

**Change:** Poll while setup is pending (reuse the DevicesSection approach), refresh on return to the tab, expose Retry, and show explicit “waiting for installation / paired / online” states. Offer to enter the workspace once reachable.

**Acceptance:** Pairing becomes visible within a defined short interval without reload. A failed request can be retried in place without losing setup progress.

### N4 · P1 · Existing local repositories depend on GitHub CLI discovery

**User experience:** The user connects their local instance and chooses the folder containing their projects, but the main repository picker can remain empty. Signing into the hosted app with GitHub has not authenticated `gh` on that computer. Local-only or non-GitHub repositories are never discovered. An existing flat checkout such as `~/repos/project` is shown as not cloned, and opening it clones a *second* copy into `~/repos/owner/project`.

**Evidence:** [`/api/repos`](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/upload-routes.ts#L274) begins with `gh api user` and builds groups from `gh repo list`; it is the frontend's only repository source (sidebar, landing page, and command palette all use `useRepos`). [Repository mapping](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/upload-routes.ts#L129) is `join(reposRoot, owner, name)`. The only directory browser, `/api/browse-dirs` (`session-routes.ts:443`), backs a `FolderPicker` that can only set the repositories-root setting — it cannot open a folder or start a session — and it only permits browsing under the home directory and the env default root, not a custom root. [Hosted OAuth](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/relay/relay-auth-routes.ts#L1) uses GitHub for identity and discards the token. `README.md:59` advertises “Auto-discovers local repos and GitHub org repos”; the local half is not true.

Two further fragilities in the same route: a failure in any single org's `gh repo list` (SSO-enforced org, rate limit) falls into the shared catch and empties *all* groups, and `--limit 100` silently truncates large owners.

**Change:** Make “Open a folder on My laptop” a primary path and discover existing Git checkouts (flat and owner-namespaced) independently of GitHub. Match discovered checkouts to GitHub repos by remote URL rather than path. Treat GitHub browsing/cloning as an optional integration with its own local-auth state; isolate per-org failures. Explain which computer a path refers to.

**Acceptance:** A user with an authenticated supported agent and an existing local repository can start without installing or authenticating `gh`, moving their repository, or cloning it again. One failing org does not hide the others.

### N5 · P1 · The advertised multi-agent installation still requires Claude

**User experience:** A user who already runs Codex or OpenCode follows the installer and is stopped because `claude` is missing. The public site describes any of the supported CLIs as sufficient; the README (`README.md:17`) instead lists Claude as required and the others as optional — the two public sources disagree.

**Evidence:** [check_claude](https://github.com/Multiplier-Labs/codekin/blob/594fc75/install.sh#L52) ends in `exit 1` and is called unconditionally before package installation (`install.sh:161-164`), whereas `check_github` only warns. The hosted install command runs this same script. This is a source-confirmed branch, not a clean-machine installation test. First raised as N4 in the 2026-08-29 audit.

**Change:** Accept any supported installed agent (`claude`, `codex`, `opencode`; the list should come from one registry so future harnesses such as Grok Build are covered automatically); guide users who have none to choose one. Show OS and agent prerequisites before generating the command. Align README and site copy.

**Acceptance:** Both Codex-only and OpenCode-only computers can complete hosted setup. Windows users receive an explicit supported-platform explanation rather than only a Bash command.

### N6 · P2 · Repository and agent readiness can mislead the user

**User experience:** A failed or timed-out repository fetch looks like “No repositories yet.” Installed-but-unauthenticated `gh` appears ready, while the suggested fix is changing the repositories path. Missing optional agents keep the checklist expanded even when one usable agent is enough. Clicking a repository on the landing page in a fresh browser starts a Claude session, even if Claude is unavailable.

**Evidence:** [App](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/App.tsx#L75) discards `useRepos` loading/error state, so a 504 timeout also renders as empty. The [server](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/upload-routes.ts#L312) sets `ghMissing` only on `ENOENT` and maps other failures to empty groups. The [checklist](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/lib/environmentChecklist.ts#L39) interprets `false` as ready and suggests setting the repositories path. `EnvironmentChecklist.tsx:34-37` collapses only when every row is ready. [Default provider](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/App.tsx#L160) falls back to `'claude'` and [first session creation](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hooks/useSessionOrchestration.ts#L80) uses it without consulting health. By contrast, `NewSessionButton.tsx:128-133` and `RepoSection.tsx:341` already filter providers by health — the gap is specifically the landing-page default. Source-traced, not exercised against a live agent.

**Change:** Separate loading, no projects, `gh` not authenticated, and network/timeout failure. Show one usable agent as sufficient; collapse optional integrations. Derive the default provider from the first healthy agent, reusing `providerAvailability`.

**Acceptance:** Each failure has a correct next action. With only a non-Claude agent available, the first landing-page repository click starts a session with that agent.

### N7 · P2 · Pairing expiry is displayed incorrectly and starts too early

**User experience:** A command still says “expires in 10 min” after eleven minutes. Installation and provider setup consume the same ten-minute validity window. If regenerating an already displayed token fails, the error is not shown.

**Evidence:** [InstallCommand](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/InstallCommand.tsx#L43) computes `minutesLeft` only inside `generate()` and renders it statically; Chromium clock advancement reproduced the stale label. `PAIRING_TTL_MS` is ten minutes (`pairing.ts:16`) and claim checks it (`pairing.ts:212`). The installer runs Node/agent checks, `npm install`, the interactive `codekin setup`, and service installation before pairing (`install.sh:161-167`). `error` renders only in the no-token branch.

**Change:** Show a live countdown and an expired state, disable stale commands, surface regeneration errors, and design recovery around slow installs. Prefer claiming the credential *early* (first step of the installer, before `npm install`) over lengthening the TTL — a longer-lived bearer token in a copy-pasted command widens N10's exposure.

**Acceptance:** Advancing time beyond expiry never leaves a valid-looking command. Regeneration failure is visible even when an older token exists. A slow `npm install` cannot cause pairing to expire.

### N8 · P2 · Public entry and account admission do not explain the hosted path

**User experience:** The marketing site and README teach install → local URL → token. Hosted sign-in says “your team's coding agents,” without explaining that execution happens on the user's computer. New identities must be allowlisted; rejection says the instance is private but gives no request-access action. CLI-first pairing via GitHub sign-in loses its `/pair?code=...` destination because successful OAuth redirects to `/` (passkey sign-in re-checks the session in place and does preserve it).

**Evidence:** Live marketing and sign-in inspection; [README](https://github.com/Multiplier-Labs/codekin/blob/594fc75/README.md#L22) (L22-34, no mention of app.codekin.ai or `codekin relay`); [LoginPage](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/LoginPage.tsx#L46); [OAuth admission and redirect](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/relay/relay-auth-routes.ts#L180) — the session stores only `oauthState`, and success redirects to `'/'` (`:202`). The allowlist is a deliberate decision (D3 in `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md`); actual production membership was not inspected. Private access may be intentional; unexplained admission remains friction.

**Change:** Lead the public journey with “Open Codekin → connect your computer.” Describe the browser/relay/local execution model, supported OSes, and separate agent authentication. If invitation-only, say so before OAuth and provide the actual access route. Preserve the return destination through GitHub sign-in (see N10 for constraints).

**Acceptance:** A new visitor knows what runs locally, what must be installed, and whether access is available. Signing in with GitHub from a pairing URL returns to that pairing request.

### N9 · P2 · First-run layout makes account administration compete with activation

**User experience:** After sign-in, the first page is titled “Settings.” Machine setup shares the page with “Link a device,” passkeys, and “Sign out everywhere.” “Machine” versus “device” requires understanding two different linking operations before doing useful work. On mobile, users receive a computer-terminal command without a dedicated continue-on-computer handoff.

**Evidence:** `HostedApp.tsx:172-185` renders `<Settings machinesOnly>`; `DevicesSection` sits beneath it. Desktop/mobile browser captures below. At 390px the document did not overflow horizontally; this is a hierarchy and guidance issue, not a demonstrated responsive-layout break. The machine/device vocabulary originates in `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md`.

**Change:** Use a focused “Connect your computer” first-run surface. Explain that a computer runs agents and another device can access them. Defer account administration until setup succeeds; offer a clear desktop handoff on mobile (e.g. email/copy link to self, or reuse the QR device-link flow in reverse). Follow connection with “Choose an agent → Open a project → Ask your first question,” for example a read-only repository overview.

**Acceptance:** Each setup state has one obvious next action. A first-time user need not understand passkeys, relay terminology, or account-wide logout to reach their project.

### N10 · P1 · Security constraints on the onboarding path and its fixes

These are not usability findings, but they sit on the same path and constrain how N1, N2, N7 and N8 should be fixed.

1. **Install script fetched without a scheme.** The generated command is `curl -fsSL codekin.ai/install.sh | bash …` ([InstallCommand.tsx:82](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/InstallCommand.tsx#L82)). With no scheme, curl's first request is plain HTTP; a network attacker can serve a script before any HTTPS redirect, and it is piped straight into `bash`. Fix: `https://codekin.ai/install.sh` everywhere (UI, README, docs). Trivial and should ship first.
2. **Pairing token on the command line.** The token lands in shell history (`bash -s -- --pair TOKEN`) and is visible in the process list while `codekin relay login --code "$PAIR_TOKEN"` runs (`install.sh:143`). Single use and the 10-minute TTL limit this; fixes for N7 must not lengthen it. Pass the token to the child via environment or stdin; consider a leading-space hint or reading it interactively.
3. **Return-destination redirect.** N8's fix must not become an open redirect. Store the destination server-side in the session next to `oauthState`, allow only known same-origin paths (`/pair`, `/link`), carry through only the expected query value, and reject `//host`, `/\host`, absolute and `javascript:` URLs.
4. **Unbounded precreate.** See N2: no rate limit and no audit event on `/pair/precreate`, and superseded tokens stay valid until expiry.
5. **Allowlist privacy.** Any request-access flow (N8) must not reveal whether a given GitHub account is already allowlisted.

**Acceptance:** Generated and documented install commands use `https://`. The pairing token never appears in `ps` output of long-running processes. A crafted `returnTo` cannot leave the origin. Precreate is rate-limited and audited.

## Recommended delivery sequence

0. **Security quick wins:** N10.1 (https) and N10.4 (rate limit, audit, revoke-on-regenerate). Small, independent, no UX design needed.
1. **Make connection reliable:** N1–N3 and N7. One install, persistent connector, observable progress, resumable setup, accurate expiry, add/remove computer controls.
2. **Make local work actually local:** N4–N6. Open an existing folder, recognize any supported agent, and provide truthful readiness and failure states.
3. **Make the journey understandable:** N8–N9. Align marketing and documentation, explain access requirements, simplify first-run hierarchy, and preserve sign-in destinations (with N10.3).

The target flow is: **Open hosted app → sign in → connect computer → detect online → choose available agent and local project → first useful response.** Optional GitHub browsing, passkeys, additional devices, and automation can follow activation.

Instrument those transitions and failure reasons, especially install-command generation → claim → online → first session → first response. Do not treat command generation or a machine database row as activation. Track elapsed time and abandonment per step without recording pairing secrets or prompt contents.

## Related documents

- [`2026-08-29_nux-automation-audit.md`](2026-08-29_nux-automation-audit.md) — prior NUX audit (see table above)
- `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` — allowlist decision (D3) and open question on initial membership
- `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` — pairing and machine model
- `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md` — device-link vocabulary relevant to N9
- `docs/INSTALL-DISTRIBUTION.md` — installer distribution, relevant to N1/N5/N10.1

## Browser evidence

These screenshots use an artificial account and deliberately invalid token. Local images show a localhost relay origin because this was an isolated frontend exercise.

- [Generated install commands, desktop](2026-09-27_evidence/01-install-desktop.png) — N9 hierarchy
- [One machine present (mocked online): no “Add computer” control remains](2026-09-27_evidence/02-machine-desktop.png) — N2
- [Generated install commands, mobile](2026-09-27_evidence/03-install-mobile.png) — N9 mobile handoff
- [Live hosted sign-in](2026-09-27_evidence/04-live-sign-in.png) — N8 copy

## Verification required before calling onboarding complete

Run a real fresh-account journey on macOS and Linux with Claude-only, Codex-only, OpenCode-only, and no-agent environments. Include a flat local repo, a repo outside the default root, unauthenticated/missing `gh`, an SSO-restricted org, delayed installation, expired pairing, reload mid-setup, re-running the installer on a paired machine, network interruption, terminal closure, reboot, and opening the hosted app from a second device. Require a real first agent response and correct recovery messaging; browser mocks and passing unit tests alone are insufficient.
