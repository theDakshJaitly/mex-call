#!/usr/bin/env node
import { resolve, join } from "node:path";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Command } from "commander";
import {
  DEFAULT_CONFIG,
  VERSION,
  DEFAULT_BOT_NAME,
  DEFAULT_RECALL_BASE_URL,
  DEFAULT_VEXA_BASE_URL,
  ASSEMBLY_KEYTERMS,
  CONSENT_MESSAGE,
  mexTimelineConfirmation,
  mexSetupWedge,
  type MexCallConfig,
} from "./config.js";
import { createBrain, detectAgent } from "./brain/createBrain.js";
import { MeetingMemory } from "./memory/MeetingMemory.js";
import { detectMexScaffold, MEX_NUDGE } from "./memory/scaffold.js";
import { SimulatedTranscriptSource } from "./transport/SimulatedTranscriptSource.js";
import { PassiveLoop } from "./loops/PassiveLoop.js";
import { finalizeCall } from "./finalize.js";
import { loadEnv } from "./util/env.js";
import { fileURLToPath } from "node:url";
import { RecallTransport } from "./recall/RecallTransport.js";
import { VexaTransport } from "./vexa/VexaTransport.js";
import type { BotSession, MeetingTransport } from "./transport/MeetingTransport.js";
import { Participants } from "./transport/Participants.js";
import { loadAvatar } from "./recall/avatar.js";
import { ActiveLoop } from "./active/ActiveLoop.js";
import { detectWake } from "./active/wake.js";
import { runMex } from "./mex/runMex.js";
import { Dashboard } from "./runtime/Dashboard.js";

// Bundled Mex logo (assets/ ships with the package; ../ resolves the same from
// both dist/cli.js and src/cli.ts since each sits one level under the root).
const DEFAULT_AVATAR_PATH = fileURLToPath(new URL("../assets/mex-avatar.jpg", import.meta.url));

const log = (msg: string) => process.stderr.write(`[mex-call] ${msg}\n`);

const program = new Command();
program.enablePositionalOptions(); // lets the mex passthrough commands forward flags
program
  .name("mex-call")
  .description("Live meeting agent → agent-usable project memory (mex). MVP 0: local memory engine.")
  .version(VERSION);

program
  .command("simulate")
  .description("Run the passive loop against a transcript file (no Recall, no meeting).")
  .argument("<transcript-file>", "path to a 'Speaker: text' transcript file")
  .option("-n, --name <name>", "call name, used for the archived folder", "simulated-call")
  .option("-r, --repo <dir>", "repo whose .mex/meetings/ to write into", process.cwd())
  .option("-i, --interval <ms>", "ms between simulated transcript chunks", "800")
  .option("-c, --compact <ms>", "ms between rolling-summary compactions", String(DEFAULT_CONFIG.compactionIntervalMs))
  .option("-m, --model <alias>", "Claude model alias for compaction", DEFAULT_CONFIG.summarizerModel)
  .option("-w, --window <chars>", "sliding-window cap in characters", String(DEFAULT_CONFIG.windowMaxChars))
  .action(async (file: string, opts) => {
    const transcriptPath = resolve(file);
    if (!existsSync(transcriptPath)) {
      log(`transcript file not found: ${transcriptPath}`);
      process.exit(1);
    }

    const repoRoot = resolve(opts.repo);
    const config: MexCallConfig = {
      repoRoot,
      callName: opts.name,
      windowMaxChars: Number(opts.window),
      compactionIntervalMs: Number(opts.compact),
      summarizerModel: opts.model,
      activeModel: DEFAULT_CONFIG.activeModel, // unused in simulate (no active loop)
      actionModel: DEFAULT_CONFIG.actionModel,
      summaryTargetWords: DEFAULT_CONFIG.summaryTargetWords,
      brainTimeoutMs: DEFAULT_CONFIG.brainTimeoutMs,
      actionTimeoutMs: DEFAULT_CONFIG.actionTimeoutMs,
    };

    // mex detection + nudge — enhance if present, never block if absent.
    const mex = detectMexScaffold(repoRoot);
    if (mex.present) {
      log(`mex scaffold detected (${mex.reason}) — richer context available in later MVPs.`);
    } else {
      process.stderr.write(MEX_NUDGE + "\n");
    }

    const memory = new MeetingMemory(repoRoot);
    memory.init();
    log(`writing memory to ${memory.liveDir}`);

    const brain = createBrain({ role: "text", claudeModel: config.summarizerModel, timeoutMs: config.brainTimeoutMs });
    const loop = new PassiveLoop(memory, brain, config, { onLog: log });
    const source = new SimulatedTranscriptSource(transcriptPath, { intervalMs: Number(opts.interval) });

    log(`feeding ${source.lineCount} transcript lines at ${opts.interval}ms; compacting every ${config.compactionIntervalMs}ms`);

    let finalizing = false;
    const finalize = async (reason: string) => {
      if (finalizing) return;
      finalizing = true;
      log(`finalizing (${reason})…`);
      await source.stop();
      await loop.stop();
      const { archivePath } = await finalizeCall(memory, brain, config, log);
      log(`archived call → ${archivePath}`);
      process.exit(0);
    };

    source.onTranscript((chunk) => loop.ingest(chunk));
    source.onEnd(() => void finalize("transcript exhausted"));
    process.on("SIGINT", () => void finalize("SIGINT"));
    process.on("SIGTERM", () => void finalize("SIGTERM"));

    loop.start();
    await source.start();
  });

program
  .command("join")
  .description('Join a Google Meet (Recall or Vexa): listen, write live memory, and respond to "Mex, …".')
  .argument("<meet-url>", "Google Meet link")
  .option("-n, --name <name>", "call name, used for the archived folder", "meet-call")
  .option("-b, --bot-name <name>", "bot display name shown in the meeting", DEFAULT_BOT_NAME)
  .option("-r, --repo <dir>", "repo whose .mex/meetings/ to write into", process.cwd())
  .option("-c, --compact <ms>", "ms between rolling-summary compactions", String(DEFAULT_CONFIG.compactionIntervalMs))
  .option("-m, --model <alias>", "Claude model alias for compaction", DEFAULT_CONFIG.summarizerModel)
  .option("-w, --window <chars>", "size trigger for the unsummarized window", String(DEFAULT_CONFIG.windowMaxChars))
  .option("--transport <kind>", "meeting transport: recall | vexa", "recall")
  .option("-p, --port <port>", "local webhook port (0 = OS-assigned); recall only", "8080")
  .option("--provider <p>", "transcript provider: recallai_streaming | meeting_captions | assembly; recall only", "recallai_streaming")
  .option("--avatar <path>", "JPEG (16:9) shown as the bot's tile; 'none' to disable; recall only", DEFAULT_AVATAR_PATH)
  .option("--active-model <alias>", "Claude model alias for the active loop", DEFAULT_CONFIG.activeModel)
  .option("--action-model <alias>", "Claude model alias for in-call repo actions", DEFAULT_CONFIG.actionModel)
  .option("--no-actions", "disable in-call repo actions (Mex can still answer + log)")
  .option("--timings", "log a per-stage latency breakdown for each reply (brain vs chat send)")
  .option("--keyterms <csv>", "comma-separated terms to bias the STT toward (--provider assembly only)")
  .option("--log-transcripts", "log every finalized transcript line + whether it matched the wake word (STT A/B)")
  .option("--artifacts", "on call end, also generate follow-up-email.md and product-signals.md")
  .option("--brain <agent>", "force the brain agent: claude | codex (default: auto-detect)")
  .action(async (meetUrl: string, opts) => {
    const repoRoot = resolve(opts.repo);
    loadEnv(resolve(repoRoot, ".env"));
    loadEnv(resolve(process.cwd(), ".env"));
    loadEnv(resolve(homedir(), ".mex-call.env")); // global fallback so /mex-call works in any repo

    // Per-transport secret validation happens at transport construction below
    // (so choosing --transport vexa doesn't trip a Recall gate, and vice versa).

    const config: MexCallConfig = {
      repoRoot,
      callName: opts.name,
      windowMaxChars: Number(opts.window),
      compactionIntervalMs: Number(opts.compact),
      summarizerModel: opts.model,
      activeModel: opts.activeModel,
      actionModel: opts.actionModel,
      summaryTargetWords: DEFAULT_CONFIG.summaryTargetWords,
      brainTimeoutMs: DEFAULT_CONFIG.brainTimeoutMs,
      actionTimeoutMs: DEFAULT_CONFIG.actionTimeoutMs,
    };

    const mex = detectMexScaffold(repoRoot);
    if (mex.present) log(`mex scaffold detected (${mex.reason}) — richer context available in later MVPs.`);
    else process.stderr.write(MEX_NUDGE + "\n");

    const memory = new MeetingMemory(repoRoot);
    memory.init();
    log(`writing memory to ${memory.liveDir}`);

    const agent = detectAgent(opts.brain);
    log(`brain: ${agent}${opts.brain ? " (forced)" : " (auto-detected)"}`);

    const brain = createBrain({ role: "text", agent, claudeModel: config.summarizerModel, timeoutMs: config.brainTimeoutMs });
    const participants = new Participants();

    // Pre-rendered live dashboard (no model cost). The /mex-call session and
    // `mex-call watch` read these files; we rewrite them on every event.
    const dashboard = new Dashboard(
      memory.liveDir,
      { callName: config.callName, meetUrl, botName: opts.botName },
      memory,
      participants
    );
    const activity = (icon: string, text: string) => {
      dashboard.add(icon, text);
      dashboard.write();
    };
    try {
      writeFileSync(join(memory.liveDir, "runtime.pid"), String(process.pid));
    } catch {
      /* ignore */
    }
    dashboard.write();

    const loop = new PassiveLoop(memory, brain, config, {
      onLog: log,
      onCompaction: (out) => {
        const p: string[] = [];
        if (out.newDecisions.length) p.push(`+${out.newDecisions.length} decisions`);
        if (out.newActionItems.length) p.push(`+${out.newActionItems.length} actions`);
        if (out.newOpenQuestions.length) p.push(`+${out.newOpenQuestions.length} questions`);
        activity("🧠", `memory compacted${p.length ? ` (${p.join(", ")})` : ""}`);
      },
    });

    // Transport selection. Recall is the zero-setup default; Vexa is the
    // open-source option. Each validates its OWN secrets here so neither gate
    // trips the other. The loops/runtime below depend only on the BotSession
    // interface, so everything past this point is transport-agnostic.
    const transportKind = String(opts.transport || "recall").toLowerCase();
    let transport: MeetingTransport;
    if (transportKind === "vexa") {
      const apiKey = process.env.VEXA_API_KEY;
      if (!apiKey) {
        log("VEXA_API_KEY is not set. Add it to .env (VEXA_API_KEY=...) or the environment, or use --transport recall.");
        process.exit(1);
      }
      const baseUrl = process.env.VEXA_API_URL || DEFAULT_VEXA_BASE_URL;
      // Honest about the tier: hosted is the realistic "open" path but still an
      // API key (open-source vendor, not keyless); self-host points at your URL.
      const tier =
        baseUrl === DEFAULT_VEXA_BASE_URL
          ? "hosted (open-source vendor — uses VEXA_API_KEY)"
          : `self-hosted (${baseUrl})`;
      log(`transport: vexa — ${tier}`);
      transport = new VexaTransport({ apiKey, baseUrl, log });
    } else if (transportKind === "recall") {
      const apiKey = process.env.RECALL_API_KEY;
      if (!apiKey) {
        log("RECALL_API_KEY is not set. Add it to .env (RECALL_API_KEY=...) or the environment.");
        process.exit(1);
      }
      const baseUrl = process.env.RECALL_API_URL || DEFAULT_RECALL_BASE_URL;
      const avatar =
        opts.avatar && opts.avatar !== "none" ? loadAvatar(resolve(opts.avatar), log) ?? undefined : undefined;
      if (avatar) log(`bot tile: ${opts.avatar}`);
      log("transport: recall");
      const recallProvider =
        opts.provider === "meeting_captions"
          ? "meeting_captions"
          : opts.provider === "assembly"
            ? "assembly_ai_v3_streaming"
            : "recallai_streaming";
      const keyterms = opts.keyterms
        ? String(opts.keyterms).split(",").map((s) => s.trim()).filter(Boolean)
        : ASSEMBLY_KEYTERMS;
      if (recallProvider === "assembly_ai_v3_streaming") {
        log(`stt: AssemblyAI v3 streaming (keyterms: ${keyterms.join(", ") || "none"})`);
      }
      transport = new RecallTransport({
        apiKey,
        baseUrl,
        port: Number(opts.port),
        transcriptProvider: recallProvider,
        keyterms,
        avatar,
        log,
      });
    } else {
      log(`unknown --transport "${transportKind}" (expected: recall | vexa)`);
      process.exit(1);
    }

    let session: BotSession | undefined;
    try {
      session = await transport.join(meetUrl, { botName: opts.botName });
    } catch (err) {
      log(`failed to join: ${(err as Error).message}`);
      process.exit(1);
    }

    // Tool-enabled action brain for in-call repo actions (MVP 4): a separate
    // `claude -p` that runs IN the repo with gh/git/Write/Edit. Only fires on a
    // "repo_action" request, never on plain Q&A.
    const actionBrain =
      opts.actions === false
        ? undefined
        : createBrain({
            role: "action",
            agent,
            claudeModel: config.actionModel,
            timeoutMs: config.actionTimeoutMs,
            cwd: repoRoot,
          });
    log(actionBrain ? `in-call repo actions: on (${agent})` : "in-call repo actions: off");

    const activeLoop = new ActiveLoop(memory, brain, config, {
      sendChatMessage: (text, o) => session!.sendChatMessage(text, o),
      repoRoot,
      mexStatus: mex,
      getParticipants: () => participants.render(),
      log,
      onActivity: activity,
      actionBrain,
      timings: Boolean(opts.timings),
    });

    // Wire listeners immediately so we don't miss early events. Passive loop
    // (always) + active loop (only on the "Mex, …" wake phrase) both see finals.
    session.onTranscript((chunk) => {
      if (opts.logTranscripts && chunk.isFinal) {
        const wake = detectWake(chunk.text).hit ? "yes" : "no";
        log(`[stt] final ${chunk.speaker}: "${chunk.text}" wake=${wake}`);
      }
      loop.ingest(chunk);
      activeLoop.consider(chunk);
    });
    session.onParticipantChange((ev) => {
      if (participants.applyAndChanged(ev)) {
        memory.writeParticipants(participants.render());
        const verb = ev.type === "join" ? "joined" : ev.type === "leave" ? "left" : "updated";
        activity("👋", `${ev.name} ${verb}`);
      }
    });
    session.onStatus((status) => {
      dashboard.setStatus(status);
      activity("🔄", `status: ${status}`);
    });

    let finalizing = false;
    const finalize = async (reason: string) => {
      if (finalizing) return;
      finalizing = true;
      log(`finalizing (${reason})…`);
      try {
        unlinkSync(join(memory.liveDir, "runtime.pid"));
      } catch {
        /* ignore */
      }
      dashboard.setStatus("ending");
      dashboard.add("⏹", `finalizing (${reason})`);
      dashboard.markEnded();
      dashboard.write(); // final snapshot while memory is still in live/
      await loop.stop();
      const { archivePath, detected, loggedEvents } = await finalizeCall(memory, brain, config, log, {
        artifacts: opts.artifacts,
        // Piece A: log to the event log only when a real mex scaffold is present.
        events: mex.present ? { projectRoot: repoRoot, scaffoldRoot: mex.mexDir } : undefined,
      });
      log(`archived call → ${archivePath}`);

      // Piece B: one closing message — confirm to mex users, nudge non-mex users.
      // The wedge names what was just captured and where it's currently going
      // nowhere a coding agent can reach. Don't nag: a single post, best-effort.
      try {
        const closing = mex.present
          ? mexTimelineConfirmation(
              loggedEvents?.decisions ?? 0,
              loggedEvents?.actionItems ?? 0,
              loggedEvents?.openQuestions ?? 0
            )
          : mexSetupWedge(detected.decisions, detected.actionItems, detected.openQuestions);
        if (closing) {
          await session!.sendChatMessage(closing);
          activity("💬", mex.present ? "confirmed mex timeline write" : "posted mex setup nudge");
        }
      } catch (err) {
        log(`closing message failed: ${(err as Error).message}`);
      }

      try {
        await session!.leave();
      } catch {
        /* already left */
      }
      process.exit(0);
    };

    session.onCallEnd(() => void finalize("call ended"));
    process.on("SIGINT", () => void finalize("SIGINT"));
    process.on("SIGTERM", () => void finalize("SIGTERM"));

    loop.start();

    // Consent message (required): post once the bot is actually in the call.
    session
      .whenInCall()
      .then(async () => {
        try {
          await session!.sendChatMessage(CONSENT_MESSAGE, { pinned: true });
          log("posted pinned consent message");
          activity("💬", "consent posted (pinned)");
        } catch (err) {
          log(`consent message failed: ${(err as Error).message}`);
        }
      })
      .catch((err: unknown) => log(`waiting for join: ${(err as Error).message}`));

    log('listening… say "Mex, …" to address the bot. (Ctrl-C makes it leave and archives the call)');
  });

program
  .command("watch")
  .description("Live terminal dashboard for a running call (reads .mex/meetings/live).")
  .option("-r, --repo <dir>", "repo whose live call to watch", process.cwd())
  .option("-i, --interval <ms>", "refresh interval", "1000")
  .option("--once", "print a single snapshot and exit")
  .action((opts) => {
    const dashPath = join(resolve(opts.repo), ".mex", "meetings", "live", "dashboard.md");
    const render = () =>
      existsSync(dashPath)
        ? readFileSync(dashPath, "utf8")
        : `No live call found at ${dashPath}\nStart one with:  mex-call join <meet-url>`;

    if (opts.once) {
      process.stdout.write(render().trimEnd() + "\n");
      return;
    }
    const tick = () => process.stdout.write("\x1b[2J\x1b[H" + render().trimEnd() + "\n");
    tick();
    const timer = setInterval(tick, Number(opts.interval));
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.stdout.write("\n");
      process.exit(0);
    });
  });

program
  .command("leave")
  .description("Tell a running mex-call bot to leave and archive the call.")
  .option("-r, --repo <dir>", "repo whose live call to stop", process.cwd())
  .action((opts) => {
    const pidPath = join(resolve(opts.repo), ".mex", "meetings", "live", "runtime.pid");
    if (!existsSync(pidPath)) {
      log("no running call found (no runtime.pid).");
      process.exit(1);
    }
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (!pid) {
      log("invalid runtime.pid.");
      process.exit(1);
    }
    try {
      process.kill(pid, "SIGINT");
      log(`sent leave signal to mex-call (pid ${pid}); it will archive and exit.`);
    } catch (err) {
      log(`could not signal pid ${pid}: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("setup [mexArgs...]")
  .description("Set up mex in this repo (runs the bundled `mex setup`). Optional — mex-call runs without it.")
  .allowUnknownOption(true)
  .passThroughOptions()
  .action(async (mexArgs: string[] = []) => {
    process.exit(await runMex(["setup", ...mexArgs], process.cwd()));
  });

program
  .command("mex [args...]")
  .description('Run any bundled mex command (e.g. `mex-call mex init`, `mex-call mex log "decided X"`).')
  .allowUnknownOption(true)
  .passThroughOptions()
  .action(async (args: string[] = []) => {
    process.exit(await runMex(args, process.cwd()));
  });

program.parseAsync(process.argv).catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
