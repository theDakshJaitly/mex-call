# mex-call

A live meeting agent that gives your AI coding agent a seat in the room. A bot
joins a Google Meet, listens, and continuously turns the conversation into
**bounded, structured, agent-readable memory** under `.mex/meetings/` — the
decisions, action items, and open questions that get made in calls but never
make it back to the code.

It is built on [mex](https://github.com/theDakshJaitly/mex) but does **not**
require it: run it in any repo and it works standalone; in a repo that already
has a mex scaffold, it gets smarter (it can read your architecture, conventions,
and past decisions).

> **No voice, ever.** The bot doesn't talk. Its output is chat messages, files,
> and (soon) repo actions. That single decision removes all the streaming/TTS
> latency machinery and leaves one brain: **Claude Code**.

## How it works

```
Recall.ai bot ── joins Meet, visible as "Mex", realtime transcript ──┐
                                                                     ▼
  PASSIVE loop (always on):  transcript → window → compact → shed     (homeostatic memory)
       every 45s / on size:  rolling-summary.md + decisions / action-items / open-questions
                                                                     ▼
                         .mex/meetings/live/*  ──(call end)──▶  .mex/meetings/<date>-<name>/*
```

The passive loop never sends the full transcript to the model — only a bounded
`current-window` plus the `rolling-summary`, so memory stays bounded no matter
how long the call runs. The brain is headless `claude -p` (uses your Claude Code
auth — no API key needed).

## Install

```bash
npm install
npm run build
```

## Usage

### `simulate` — local memory engine (no meeting, no Recall)

Feed a `Speaker: text` transcript file on a timer to validate the memory engine:

```bash
node dist/cli.js simulate examples/sample-standup.txt --name standup --repo .
```

### `join` — join a real Google Meet (Recall)

```bash
# 1. set your Recall key
cp .env.example .env      # then add RECALL_API_KEY=...

# 2. expose the local webhook server (dev). Auto-detected — no copy/paste.
ngrok http 8080

# 3. join a meeting (memory lands in --repo)
node dist/cli.js join "https://meet.google.com/abc-defg-hij" --repo .
```

The bot joins as **Mex (notetaker)**, posts a pinned consent message, and writes
live memory as people talk. `Ctrl-C` makes it leave and archives the call.

## Configuration

| Env | Purpose |
| --- | --- |
| `RECALL_API_KEY` | Recall API key (server-side secret). |
| `RECALL_API_URL` | Region base URL. Default `https://us-west-2.recall.ai`. |
| `MEXCALL_PUBLIC_URL` | Public webhook URL for production (skips ngrok auto-detect). |

Claude Code auth is used for the brain — no `ANTHROPIC_API_KEY` required.

## Memory layout

```
.mex/meetings/
  live/                    # live state during a call
    transcript.md          # full, append-only (never sent to the model)
    current-window.md      # unsummarized buffer — shed after each compaction
    rolling-summary.md     # continuously compacted, bounded
    decisions.md · action-items.md · open-questions.md · participants.md
  <date>-<name>/           # archived on call end, + final-summary.md
```

## Design rules

- **No voice.** Chat + files + repo actions only.
- **mex is optional.** Detect a scaffold → enhance; else run standalone + nudge.
- **Only ever write inside `.mex/meetings/`.** Other `.mex/` files are read-only.
- **Every external dependency sits behind a swappable interface** (`MeetingTransport`, `SttSource`, `Brain`).
- **The passive loop stays bounded.** Window + summary, never the full transcript.

## Status

- **MVP 0 ✅** Local memory engine (`simulate`).
- **MVP 1 ✅** Recall listener (`join`) — joins, consent, live transcript, participants, archive. Rate-limited Recall client.
- **MVP 2** Active loop — wake phrase "Mex, …" → Claude acts → chat reply.
- **MVP 3** Claude Code plugin slash command.
- **MVP 4** Repo actions (create issue, update docs, follow-ups).

## License

MIT
