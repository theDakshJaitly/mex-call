# mex-call

> **Claude Code, now in your Google Meet** — with the memory and context powers of [mex](https://github.com/theDakshJaitly/mex).

A bot joins your Google Meet, listens, and turns the conversation into **bounded,
structured, agent-readable memory** in your repo — the decisions, action items, and
open questions that get made in calls but never make it back to the code. Say
**"Mex, …"** and it answers in the chat or acts in the repo (create an issue, draft
a doc), grounded in what was actually said. It never speaks; output is chat, files,
and repo actions.

It runs on your coding agent's own brain — **Claude Code** (`claude -p`) or
**Codex** (`codex exec`), auto-detected — and on **mex** for project memory
(bundled; optional).

## Install

First, a free [Recall.ai](https://www.recall.ai) API key (the bot that joins the
call). Put it where mex-call will find it in any repo:

```bash
echo "RECALL_API_KEY=your-key" > ~/.mex-call.env
```

### Claude Code → plugin

```
/plugin marketplace add theDakshJaitly/mex-call
/plugin install mex-call@mex-call
```

Then in any repo: **`/mex-call:call <google-meet-link>`**

### Codex, Cursor, or any terminal → npm

```bash
npm install -g mex-call
```

Then in any repo: **`mex-call join <google-meet-link>`** — the brain auto-detects
Claude Code vs. Codex.

> **Dev note:** Recall needs a public webhook URL. Run `ngrok http 8080` and
> mex-call auto-detects it (or set `MEXCALL_PUBLIC_URL` to a deployed domain).

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

## Usage

Admit **"Mex (notetaker)"** when it knocks. It posts a pinned consent message and
writes live memory as people talk. During the call:

- **Just listening** — every chunk is compacted into a bounded rolling memory;
  decisions, action items, and open questions are detected automatically.
- **"Mex, summarize where we are"** → it replies in the meeting chat.
- **"Mex, log that as a decision"** → appends to `decisions.md` and confirms.
- **"Mex, create an issue for that"** → opens a real GitHub issue / drafts a doc,
  grounded in the call, and confirms in chat.

Control it:

```bash
mex-call watch     # live terminal dashboard for the call
mex-call leave     # bot leaves and archives the call to .mex/meetings/<date>-<name>/
```

On call end it archives a finalized folder (final summary, decisions, action items,
open questions, full transcript). Add `--artifacts` to also generate a follow-up
email and product signals.

### Try it without a meeting

```bash
mex-call simulate path/to/transcript.txt --name standup
```

Feeds a `Speaker: text` file through the memory engine — no Recall, no meeting.
(There's a sample at `examples/sample-standup.txt` in the repo.)

## From source

```bash
git clone https://github.com/theDakshJaitly/mex-call && cd mex-call
npm install && npm run build && npm link   # global `mex-call`
```

## Configuration

| Env | Purpose |
| --- | --- |
| `RECALL_API_KEY` | Recall API key (server-side secret). |
| `RECALL_API_URL` | Region base URL. Default `https://us-west-2.recall.ai`. |
| `MEXCALL_PUBLIC_URL` | Public webhook URL for production (skips ngrok auto-detect). |
| `MEXCALL_BRAIN` | Force the brain agent: `claude` or `codex` (default: auto-detect). |
| `MEXCALL_CODEX_MODEL` | Model for the codex brain (else codex's default). |

The brain uses your coding agent's own auth — no `ANTHROPIC_API_KEY` required.

## Works with any coding agent

The runtime is a plain CLI, and its output — structured `.mex/meetings/` memory +
repo actions — is consumed by **any** agent that reads the repo. The brain
auto-detects which agent is driving it and uses that agent's headless CLI:

- **Claude Code** → `claude -p` (and the `/mex-call:call` plugin command)
- **Codex** → `codex exec` (no plugin needed — just run `mex-call join …` in the terminal)

Detection order: `--brain` / `MEXCALL_BRAIN` → env markers (`CLAUDECODE` / `CODEX_*`)
→ whichever CLI is installed. Force it with `mex-call join … --brain codex`.

## mex is bundled

mex ships with mex-call (the `mex-agent` dependency) — no separate install. It's
optional (mex-call runs standalone), but when you want the richer scaffold:

```bash
mex-call setup            # runs the bundled `mex setup` in this repo
mex-call mex <command>    # any mex command, e.g. `mex-call mex init`, `mex-call mex log "..."`
```

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
- **MVP 2 ✅** Active loop — wake phrase "Mex, …" → Claude reads live memory (+ repo `.mex/` context) → answers or logs a decision/action-item → chat reply. Passive loop keeps running throughout.
- **MVP 3 ✅** `/mex-call <link>` launches the runtime; the session becomes a live, model-free dashboard. Plus `mex-call watch` (terminal) and `mex-call leave`. Packaged as a Claude Code **plugin** (model-invoked how-to skill, user-only launcher, live-stream monitor, self-installing build hook) installable via a marketplace.
- **MVP 4 ✅** In-call repo actions — "Mex, create an issue / update the docs / open a PR" routes to a tool-enabled action brain (`claude -p` with `gh`/`git`/`Write`/`Edit`, running in the repo) that does the work grounded in live memory and confirms in chat. Plus opt-in post-call artifacts (`--artifacts` → `follow-up-email.md`, `product-signals.md`).

## License

MIT
