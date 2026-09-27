# Hosted Codekin: new-user experience audit

Date: 2026-09-27. Intended journey: hosted web app → connect the user's local Codekin instance → open an existing repository → get the first useful agent response.

## Assessment

The journey has functional gaps before the first coding session, not just rough presentation. A technically capable user can get through with terminal knowledge, manual reloads, and familiarity with Codekin's architecture. The product currently relies on that knowledge at exactly the points where a new user does not have it.

There are useful foundations: account sign-in, generated pairing commands, remembered machines, connection preflight and retry, an environment checklist, folder browsing, and inline clone failures. The highest-value work is joining these into a reliable setup flow.

## Evidence and limits

- Reviewed checkout `594fc75b072dc1705ea20b0ed700435e1e8ddd7c`. Its two commits above `origin/main` (`fbcc9dc`) change only the Grok specification; audited runtime code is the same.
- Inspected the live [marketing site](https://codekin.ai/) and the live [hosted sign-in screen](https://app.codekin.ai/). Did not authenticate to production or create production accounts, machines, or sessions.
- Built hosted mode and exercised the production frontend bundle locally in Chromium at 1280×900 and 390×844. Account, machine, pairing-token, and passkey API responses were mocked. These checks validate frontend behavior, not deployment or end-to-end connectivity.
- Reproduced precreated orphan machines with the real pairing functions and an in-memory database.
- Traced installer, service, authentication, repository discovery, and session-creation code. Did not execute the installer on a clean Mac/Linux machine, test OS service persistence, or run a real agent conversation.
- Hosted Vite build succeeded. Six existing focused test files passed: 62 tests across machines, environment checklist, session orchestration, pairing, and relay auth. Passing unit tests do not cover the complete onboarding journey.

Source links below use the reviewed revision. P1 means an activation or recovery blocker for the stated cohort; P2 means significant confusion or avoidable friction. These priorities are qualitative, not measured conversion impact.

## Findings

### N1 · P1 · Installation does not leave a hosted machine online

**User experience:** Copy the generated installer, complete installation, and return to the browser. The local server runs as a service, but the relay connector does not. The user must notice terminal output and separately run `codekin relay connect`, which stays in the foreground. Closing that terminal stops this connector; the installed server service does not restart it.

**Evidence:** [installer pairing and completion](https://github.com/Multiplier-Labs/codekin/blob/594fc75/install.sh#L139), [foreground connector command](https://github.com/Multiplier-Labs/codekin/blob/594fc75/bin/codekin.mjs#L256), and [connector lifecycle](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/relay/connector-cli.ts#L1). Installer completion also sends users toward `codekin token`, the local-access path. Pairing failure is caught and the script still prints installation complete.

**Change:** Make the hosted installer install/start a persistent connector alongside the server, verify hosted reachability, and finish with “Your machine is online; return to Codekin.” Distinguish local installation success from pairing or connection failure. Explain that the computer must remain awake and online.

**Acceptance:** After one successful installation, the hosted page detects the machine without another command. Closing the installation terminal and rebooting preserve connectivity through the managed service. Failed pairing never produces an unqualified hosted-setup success message.

### N2 · P1 · Command generation can strand users after a reload

**User experience:** Generate an install command, get interrupted, then reload. The generator is gone and an offline “Unnamed machine” can be left behind. The UI offers neither a replacement command nor removal of that record. This also prevents adding a second machine through the generator once any machine exists, including one shared with the user.

**Evidence:** [precreatePairing](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/relay/pairing.ts#L118) creates a machine during approval, before the installer claims it. [MachinesSection](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/MachinesSection.tsx#L54) renders `InstallCommand` only for an empty machine list. In-memory reproduction: command generation produced `{ name: 'Unnamed machine', status: 'offline' }`; after forcing expiry, claim returned `expired` and the machine count remained 1. Browser verification confirmed the generator disappears for a nonempty list.

**Change:** Keep “Add computer” available regardless of machine count. Represent unfinished setup explicitly, with resume/regenerate/cancel. Avoid presenting an unclaimed pairing as an ordinary offline machine; clean up abandoned records or create the permanent machine on claim.

**Acceptance:** Generate → reload → expire → resume works entirely through the UI. An existing or shared machine never removes the ability to add another.

### N3 · P1 · The setup page does not observe progress or recover from list failure

**User experience:** A machine can pair and come online while the page still says “No machines paired yet.” A transient machine-list failure leaves only an error sentence, without Retry.

**Evidence:** [MachinesSection's mount-only fetch](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/MachinesSection.tsx#L35). In Chromium, changing the mocked backend from empty to online produced **zero additional requests over 5.5 seconds** and the empty state remained. There is no timer, focus refresh, or explicit refresh control in the source. A mocked 503 displayed the error with no retry action.

**Change:** Poll while setup is pending, refresh on return to the tab, expose Retry, and show explicit “waiting for installation / paired / online” states. Offer to enter the workspace once reachable.

**Acceptance:** Pairing becomes visible within a defined short interval without reload. A failed request can be retried in place without losing setup progress.

### N4 · P1 · Existing local repositories depend on GitHub CLI discovery

**User experience:** The user connects their local instance and chooses the folder containing their projects, but the main repository picker can remain empty. Signing into the hosted app with GitHub has not authenticated `gh` on that computer. Local-only or non-GitHub repositories are not independently discovered by this route. An existing flat checkout such as `~/repos/project` may be treated as remote because this mapper checks `~/repos/owner/project`.

**Evidence:** [repository listing](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/upload-routes.ts#L274) begins with `gh api user` and builds groups from `gh repo list`; there is no independent local directory scan in this route. [Repository mapping](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/upload-routes.ts#L133) checks owner-namespaced paths. [Hosted OAuth](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/relay/relay-auth-routes.ts#L1) uses GitHub for identity and discards the token. The README nevertheless advertises local repo auto-discovery.

**Change:** Make “Open a folder on My laptop” a primary path and discover existing Git checkouts independently of GitHub. Treat GitHub browsing/cloning as an optional integration, with its own local-auth state. Explain which computer a path refers to.

**Acceptance:** A user with an authenticated supported agent and an existing local repository can start without installing or authenticating `gh`, moving their repository, or cloning it again.

### N5 · P1 · The advertised multi-agent installation still requires Claude

**User experience:** A user who already runs Codex or OpenCode follows the installer and is stopped because `claude` is missing. The public site says any of the three supported CLIs is a prerequisite.

**Evidence:** [check_claude](https://github.com/Multiplier-Labs/codekin/blob/594fc75/install.sh#L52) exits before package installation. It is called unconditionally. This is a source-confirmed branch, not a clean-machine installation test.

**Change:** Accept any supported installed agent; guide users who have none to choose one. Show OS and agent prerequisites before generating the command.

**Acceptance:** Both Codex-only and OpenCode-only computers can complete hosted setup. Windows users receive an explicit supported-platform explanation rather than only a Bash command.

### N6 · P2 · Repository and agent readiness can mislead the user

**User experience:** A failed repository fetch looks like “No repositories yet.” Installed-but-unauthenticated `gh` can appear ready, while the suggested fix is changing the repositories path. Missing optional agents also expand the checklist even when one usable agent is enough. The first repository click defaults to Claude in a fresh browser rather than selecting an available provider.

**Evidence:** [App](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/App.tsx#L75) discards `useRepos` loading/error state. The [server](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/upload-routes.ts#L312) maps non-timeout GitHub failures to empty groups with `ghMissing=false` unless the binary is absent. The [checklist](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/lib/environmentChecklist.ts#L39) interprets false as ready. [Default provider](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/App.tsx#L160) and [first session creation](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hooks/useSessionOrchestration.ts#L80) do not choose from health results. That provider path was source-traced, not exercised against a live agent.

**Change:** Separate loading, no projects, local-auth failure, and network failure. Show one usable agent as sufficient; collapse optional integrations. Ask for or infer a usable provider before the first session.

**Acceptance:** Each failure has a correct next action. An available non-Claude provider can be selected before the first repository session, with no attempt to launch a missing default agent.

### N7 · P2 · Pairing expiry is displayed incorrectly and starts too early

**User experience:** A command still says “expires in 10 min” after eleven minutes. Installation and provider setup consume the same ten-minute validity window. If regenerating an already displayed token fails, the existing-token branch does not render the error.

**Evidence:** [InstallCommand](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/InstallCommand.tsx#L43) computes remaining minutes only when generating; Chromium clock advancement reproduced the stale label. The real pairing TTL is ten minutes and claim checks expiry. Installation precedes pairing.

**Change:** Show actual expiry and an expired state, disable stale commands, surface regeneration errors, and design recovery around slow installs. Consider minting/claiming the credential after prerequisite installation.

**Acceptance:** Advancing time beyond expiry never leaves a valid-looking command. Regeneration failure is visible even when an older token exists.

### N8 · P2 · Public entry and account admission do not explain the hosted path

**User experience:** The marketing site and README teach install → local URL → token. Hosted sign-in says “your team's coding agents,” without explaining that execution happens on the user's computer. New identities must be allowlisted; rejection says the instance is private but gives no request-access action. CLI-first pairing also loses its `/pair?code=...` destination across GitHub OAuth because successful login redirects to `/`.

**Evidence:** Live marketing and sign-in inspection; [README](https://github.com/Multiplier-Labs/codekin/blob/594fc75/README.md#L17); [LoginPage](https://github.com/Multiplier-Labs/codekin/blob/594fc75/src/hosted/LoginPage.tsx#L46); [OAuth admission and redirect](https://github.com/Multiplier-Labs/codekin/blob/594fc75/server/relay/relay-auth-routes.ts#L180). Actual production allowlist membership was not inspected. Private access may be intentional; unexplained admission remains friction.

**Change:** Lead the public journey with “Open Codekin → connect your computer.” Describe the browser/relay/local execution model, supported OSes, and separate agent authentication. If invitation-only, say so before OAuth and provide the actual access route. Preserve a validated return destination through sign-in.

**Acceptance:** A new visitor knows what runs locally, what must be installed, and whether access is available. Signing in from a pairing URL returns to that pairing request.

### N9 · P2 · First-run layout makes account administration compete with activation

**User experience:** After sign-in, the first page is titled “Settings.” Machine setup shares the page with “Link a device,” passkeys, and “Sign out everywhere.” “Machine” versus “device” requires understanding two different linking operations before doing useful work. On mobile, users receive a computer-terminal command without a dedicated continue-on-computer handoff.

**Evidence:** Desktop/mobile browser captures below. At 390px the document did not overflow horizontally; this is a hierarchy and guidance issue, not a demonstrated responsive-layout break.

**Change:** Use a focused “Connect your computer” first-run surface. Explain that a computer runs agents and another device can access them. Defer account administration until setup succeeds; offer a clear desktop handoff on mobile. Follow connection with “Choose an agent → Open a project → Ask your first question,” for example a read-only repository overview.

**Acceptance:** Each setup state has one obvious next action. A first-time user need not understand passkeys, relay terminology, or account-wide logout to reach their project.

## Recommended delivery sequence

1. **Make connection reliable:** N1–N3 and N7. One install, persistent connector, observable progress, resumable setup, accurate expiry, add/remove computer controls.
2. **Make local work actually local:** N4–N6. Open an existing folder, recognize any supported agent, and provide truthful readiness and failure states.
3. **Make the journey understandable:** N8–N9. Align marketing and documentation, explain access requirements, simplify first-run hierarchy, and preserve sign-in destinations.

The target flow is: **Open hosted app → sign in → connect computer → detect online → choose available agent and local project → first useful response.** Optional GitHub browsing, passkeys, additional devices, and automation can follow activation.

Instrument those transitions and failure reasons, especially install-command generation → claim → online → first session → first response. Do not treat command generation or a machine database row as activation. Track elapsed time and abandonment per step without recording pairing secrets or prompt contents.

## Browser evidence

These screenshots use an artificial account and deliberately invalid token. Local images show a localhost relay origin because this was an isolated frontend exercise.

- [Generated install commands, desktop](2026-09-27_evidence/01-install-desktop.png)
- [Machine present; installer absent](2026-09-27_evidence/02-machine-desktop.png)
- [Generated install commands, mobile](2026-09-27_evidence/03-install-mobile.png)
- [Live hosted sign-in](2026-09-27_evidence/04-live-sign-in.png)

## Verification required before calling onboarding complete

Run a real fresh-account journey on macOS and Linux with Claude-only, Codex-only, and no-agent environments. Include a local repo outside the default root, unauthenticated/missing `gh`, delayed installation, expired pairing, reload mid-setup, network interruption, terminal closure, reboot, and opening the hosted app from a second device. Require a real first agent response and correct recovery messaging; browser mocks and passing unit tests alone are insufficient.
