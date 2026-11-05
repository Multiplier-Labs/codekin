---
name: pr-demo-gif
description: Record a captioned demo GIF of a UI change in the local Codekin dev app and add it to the PR description. Use when asked for a screen recording, demo, GIF or video of a PR's change, or to refresh an existing PR demo.
---

# PR demo GIF

This skill records the running dev app with the chrome-devtools MCP and adds overlays: captions, keycaps for key presses and a ring for each click. It then trims the dead time and turns the recording into a GIF. The GIF is hosted on a `pr-assets` branch of the PR's head repo and embedded in a `## Demo` section of the PR description.

Files in this folder:

- `overlay.js`: pass its full contents as the `function` argument of `evaluate_script`. It installs `caption(text)`, `pause(ms)` and `tap(el)`, plus the key badge.
- `make-gif.sh <in.mp4> <out.gif> [--width 960] [--fps 12] [--hold 2.2]`: cuts every still stretch down to `--hold` seconds, then encodes the GIF.
- `publish.sh <pr-number> <file>...`: replaces the contents of `pr-<n>/` on the `pr-assets` branch with exactly these files. Each file gets a content hash in its name, so the URL changes with every upload. It prints a Markdown line for each file and never touches the working tree or the current branch.

## 1. Before recording

- **PR and visibility.**
  - Run `gh pr view <n> --json headRepositoryOwner,headRepository,body`.
  - `publish.sh` prints the head repo's visibility. If it is public, everything on screen becomes public, including repo names, session names and transcript text. Pick a session whose content is fine to show, or tell the user first.
- **Dev app.** The Conductor "Dev" run action starts Vite and the backend for this workspace.
  - Frontend URL: `http://localhost:$(cat .context/codekin-data/dev-port)/#token=$(cat .context/codekin-data/dev-token)`.
  - The backend runs on the frontend port + 1.
  - Read the run-script terminal output to check it is up and to see server logs.
- **Back up prefs.** The demo will change the user's real settings. Save them first, so they can be restored later:
  `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$BACKEND/api/settings/prefs > .context/prefs-backup.json`
  - To set a starting state: `PUT` the same URL with `{"patch": {"key": value}}`. A value of `null` removes the key.
  - Reload the page afterwards, because the client caches prefs.
- **Open and size the page.**
  - Open it with `new_page`, then `resize_page` to 1100×700. That size keeps text legible at 960px GIF width.
  - Put the app in the starting state **before** recording: pick the session, set the modes, close any menus.
- **Inject `overlay.js`** with `evaluate_script`.
  - Re-inject after any full reload; client-side navigation keeps it.

## 2. Record

- Start the recording: `screencast_start` with `filePath: <workspace>/.context/demo-raw.mp4`.
- Drive the flow in a few `evaluate_script` calls with `waitForStableDom: false`:
  - Use `caption('…')` and `await pause(1600–2400)` so viewers can read each step.
  - Use `await tap(el)` for clicks, so each click shows a ring.
  - Keep each caption short, under about 45 characters. It is set in 26px type.
  - Finish with `caption('')`.
- **Real keystrokes:** use `press_key` (e.g. `Shift+Tab`) so the keycap badge appears. Script-dispatched events also show the badge, but `press_key` exercises the real handler.
  - Focus the field first, e.g. `document.querySelector('.composer-card textarea').focus()`.
  - The first key press after a navigation can be lost. After each step, read the resulting state, such as a `title` attribute, before moving on.
- **Native dialogs** (`window.confirm` etc.):
  - `press_key` reports "Open dialog …". Answer it with `handle_dialog`.
  - Sometimes the tool accepts the dialog on its own. Check the app state.
  - Dialogs never appear in the screencast, so add a caption for that moment instead.
- Stop with `screencast_stop`. If a take goes wrong, reset the state and record it again rather than trying to edit the video.

## 3. Make, check and publish the GIF

```bash
S=.claude/skills/pr-demo-gif
$S/make-gif.sh .context/demo-raw.mp4 .context/<feature>.gif
# Check: one frame every 2.5 s as a contact sheet, then Read the PNG
ffmpeg -v error -y -i .context/<feature>.gif -vf "fps=1/2.5,scale=640:-2,tile=4x4" -frames:v 1 .context/contact.png
$S/publish.sh <pr-number> .context/<feature>.gif
```

- Aim for under about 60 s and a few MB. If the GIF is too big, use `--width 800` or `--fps 10`.
- Update the description:
  1. Run `gh pr view <n> --json body -q .body > .context/pr-body.md`.
  2. Add a `## Demo` section, or replace the existing one, before `## Testing`. It holds the printed `![…](…)` line and one or two sentences saying what happens in order. Mention anything that isn't visible on screen, such as dialogs.
  3. Run `gh pr edit <n> --body-file .context/pr-body.md`.
- Publishing again for the same PR replaces its old files. Earlier GIF URLs stop working, so always update the description in the same step.

## 4. Clean up

- `PUT` the backed-up values back for every pref the demo touched, and check them with a `GET`.
  - The app's mode changes also rewrite prefs; for example, choosing a mode in the composer sets `permissionMode`.
- `close_page` the tab you opened.
- Delete the raw recording, the contact sheets and the backup from `.context/`.
- Tell the user what was recorded and what was published where. Also mention any state that changed in their dev app, for example a session's mode.
