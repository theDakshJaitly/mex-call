---
description: Launch the mex-call notetaker bot into a Google Meet and stream a live dashboard in this session.
argument-hint: <google-meet-link>
disable-model-invocation: true
allowed-tools: Bash, Read
---

Launch **mex-call** — a bot that joins a Google Meet, listens, and turns the
conversation into structured memory under `.mex/meetings/` in the current repo.
Your job in THIS session is to launch it and act as a **live dashboard**.

Meeting link: `$ARGUMENTS`

The runtime does the work and pre-renders the dashboard (no model cost to show
it). The plugin's background monitor also streams each new activity line into
this session as it happens — surface those to the user.

## Steps

1. **Sanity check.** If `$ARGUMENTS` is empty or not a `meet.google.com` link,
   stop and ask for a valid Google Meet link. Resolve the CLI: prefer
   `mex-call` on PATH; otherwise use `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"`
   (the plugin's bin and a SessionStart hook normally make `mex-call` available).

2. **Launch the bot in the background** (do NOT block — it runs the whole call):
   ```
   mex-call join "$ARGUMENTS" --repo "$(pwd)" > /tmp/mex-call.log 2>&1
   ```
   Run with run_in_background. Memory + the dashboard land in `./.mex/meetings/live/`.

3. **Wait for it to join.** Poll `./.mex/meetings/live/status.json` (the `status`
   field) with a bounded wait loop until an `in_call_*` state. While it shows
   `in_waiting_room`, tell the user clearly: **"Admit ‘Mex (notetaker)’ in the meeting."**

4. **Show the dashboard.** Read and display `./.mex/meetings/live/dashboard.md`.

5. **Keep it live.** As the background monitor streams activity (decisions, "Mex, …"
   wake triggers, replies), relay the meaningful ones and re-show the dashboard
   periodically. Stop when `status.json` shows `"ended": true` or the user stops it.

## Controls (tell the user)

- **Stop:** `mex-call leave` — the bot leaves and archives the call.
- **Terminal view:** `mex-call watch` — continuous second-by-second dashboard.
- The bot only acts when someone says **"Mex, …"** out loud.

Keep your own messages short — the dashboard is the main thing the user reads.
