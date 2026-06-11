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
live memory as people talk. `Ctrl-C` (or `mex-call leave`) makes it leave and
archives the call.

### From inside Claude Code

Put your Recall key somewhere mex-call will find it in any repo:

```bash
echo "RECALL_API_KEY=..." > ~/.mex-call.env
```

**As a plugin (recommended — ships the how-to skill + a live-stream monitor):**

```
/plugin marketplace add theDakshJaitly/mex-call     # or a local path during dev
/plugin install mex-call@mex-call
```

A `SessionStart` hook builds the bundled CLI on first run, so nothing else to set
up. Then in any repo: `/mex-call:call https://meet.google.com/abc-defg-hij`. The
runtime launches in the background, the session becomes a **live dashboard**
(status, participants, rolling summary, decisions/actions, and every "Mex, …"
trigger + reply), and the plugin's background monitor streams each new event into
the session as it happens. The runtime pre-renders the dashboard, so it costs no
model calls. Claude also gains a model-invoked `meeting-notetaker` skill so it
knows when to suggest mex-call.

**Standalone (clean `/mex-call` name, no plugin):**

```bash
npm link                                              # global `mex-call` binary
cp .claude/commands/mex-call.md ~/.claude/commands/   # the /mex-call command
```

Then: `/mex-call https://meet.google.com/abc-defg-hij`.

### `mex-call watch` / `mex-call leave`

```bash
mex-call watch   # continuous second-by-second terminal dashboard for the live call
mex-call leave   # make the bot leave and archive the call
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

- **Claude Code** → `claude -p` (and the `/mex-call` plugin)
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
