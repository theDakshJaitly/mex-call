---
description: How and when to use mex-call — a bot that joins a Google Meet, captures the conversation as structured agent-readable memory in the repo, and acts on the "Mex, …" wake phrase. Load this when the user mentions joining/recording a meeting or call, taking meeting notes, capturing decisions from a call, a standup/user-research/design review, or asks what mex-call can do. This skill is guidance only — it never joins a call by itself; launching is always user-triggered via /mex-call:call.
---

# Using mex-call

**mex-call** sends a notetaker bot into a Google Meet. It listens, continuously
writes bounded structured memory under `.mex/meetings/` in the current repo
(rolling summary, decisions, action items, open questions, participants), and
when someone says **"Mex, …"** out loud it answers in the meeting chat or records
a decision. It does not speak. It is built on [mex](https://github.com/theDakshJaitly/mex)
but never requires it — in a repo without a mex scaffold it runs standalone and
nudges; in one with a scaffold it also reads `.mex/context` and `.mex/patterns`.

## When to suggest it

If the user is about to join, or is on, a meeting they want captured into the
repo — standups, user-research calls, design/architecture reviews, client calls,
or even solo rubber-ducking — suggest launching mex-call. The value is that the
conversation stops being ephemeral and becomes durable context attached to the code.

**Do not launch it yourself.** Joining creates a real (billed) bot in a live call —
that is a side effect the user must trigger. Point them to the launcher instead.

## How to launch

`/mex-call:call <google-meet-link>` — this launches the runtime in the background
and turns the session into a live dashboard. The user must admit "Mex (notetaker)"
when it knocks. (Requires `RECALL_API_KEY` in the repo's `.env` or `~/.mex-call.env`.)

## Driving it during a call

- The dashboard (`.mex/meetings/live/dashboard.md`) shows status, participants,
  rolling summary, decisions/actions/questions, and a live activity feed. The
  plugin's background monitor streams each new activity line into the session.
- `mex-call watch` — a continuous terminal dashboard.
- `mex-call leave` — make the bot leave and archive the call to
  `.mex/meetings/<date>-<name>/`.
- The bot only acts on the explicit **"Mex, …"** wake phrase; otherwise it just
  listens and writes memory. Output is chat + files — never voice.

## After the call

The archived folder holds the final summary, decisions, action items, open
questions, and full transcript — durable, agent-readable context for future work
in this repo. If the user asks "why did we decide X?", look there.
