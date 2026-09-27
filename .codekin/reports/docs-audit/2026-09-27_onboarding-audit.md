# New user documentation assessment — 2026-09-27

## Scope

Reviewed the README, installer, CLI, landing page, repository selector, environment checklist, and setup guides for the path from installation to a first coding session. This is a documentation review; no hosted account or fresh macOS/Linux installation was exercised.

## Findings and changes

| Finding | User impact | Change |
|---|---|---|
| The README gave install commands but skipped the first session and common recovery steps. | A user could finish installation without knowing how to make an agent or repository available. | Added `docs/GETTING-STARTED.md` and linked it near the top of the README. |
| Hosted and local access were easy to confuse. | A user might open a `localhost` link on another device or expect the hosted app to run agents remotely. | Explained where the agent runs, where to execute the pairing command, and when the local token URL works. |
| The installer stops when no supported agent CLI is found, while GitHub CLI is optional. | The published prerequisite and optional-tool guidance did not explain why installation stops or what to prepare first. | Put agent setup before installation and clarified the optional GitHub CLI path. |
| The UI already offers an Environment checklist and Repositories Path picker, but the README did not point to them. | An empty repository list or unavailable agent looked like a dead end. | Documented these controls and first-run troubleshooting. |
| The advanced setup guide linked new users to a distribution document and described `.bashrc` as the source for a systemd `EnvironmentFile`. | New users entered an advanced path; systemd examples could fail because `export` lines and shell sourcing are not used by `EnvironmentFile`. | Linked to the new guide and changed the advanced examples to plain `KEY=value` entries with a service restart. |

## Follow-up risks

- The nginx/Authelia guide is a specialized deployment path and was not validated on a fresh server. Its certificate bootstrap and repository build/deploy steps deserve a separate hands-on review.
- The hosted invitation flow and installer URL were checked against repository code and documentation, not a live hosted account or a published npm package.
