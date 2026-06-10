---
description: Launch the mex-call meeting bot into a Google Meet and stream a live dashboard
argument-hint: <google-meet-link>
allowed-tools: Bash, Read
---

You are launching **mex-call** — a bot that joins a Google Meet, listens, and turns
the conversation into structured memory under `.mex/meetings/` in the current repo.
Your job in THIS session is to launch it and act as a **live dashboard** for it.

Meeting link: `$ARGUMENTS`

The runtime does all the work and pre-renders a dashboard file (no model cost to
display it). You just launch it and keep showing the refreshed dashboard.

## Steps

1. **Sanity check.** If `$ARGUMENTS` is empty or not a `meet.google.com` link, stop and
   ask the user for a valid Google Meet link. Confirm `mex-call` is on PATH with
   `command -v mex-call` — if not, use `node <this-repo>/dist/cli.js` instead and tell
   the user to run `npm link` in the mex-call repo.

2. **Launch the bot in the background** (do NOT block on it — it runs for the whole call):
   ```
   mex-call join "$ARGUMENTS" --repo "$(pwd)" > /tmp/mex-call-$$.log 2>&1
   ```
   Run it with run_in_background. Memory + the dashboard land in `./.mex/meetings/live/`.

3. **Wait for the bot to join.** Poll `./.mex/meetings/live/status.json` (the `status`
   field) until it reaches an `in_call_*` state. While it shows `in_waiting_room`, tell
   the user clearly: **"Admit ‘Mex (notetaker)’ in the meeting."** Use a bounded wait
   loop (e.g. `until grep -q in_call ./.mex/meetings/live/status.json 2>/dev/null; do sleep 2; done`
   with a timeout) rather than one long sleep.

4. **Show the dashboard.** Read `./.mex/meetings/live/dashboard.md` and display it.

5. **Keep it live.** Every ~25 seconds, re-read `dashboard.md` and show it again,
   calling out what changed (new participants, decisions, and especially each
   "Mex, …" wake trigger and the reply posted). Between refreshes, wait with a short
   bounded loop, not one long sleep. Stop refreshing when `status.json` shows
   `"ended": true` or the user tells you to stop.

## Controls (tell the user)

- **Stop the call:** `mex-call leave` (from this repo) — the bot leaves and archives
  the call to `.mex/meetings/<date>-<name>/`. You can run this when the user asks.
- **Continuous terminal view:** `mex-call watch` — a second-by-second live dashboard in
  a separate terminal.
- The bot only acts when someone says **"Mex, …"** out loud; otherwise it just listens
  and writes memory.

Keep your own messages short — the dashboard is the main thing the user reads.
