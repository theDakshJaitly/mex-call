#!/usr/bin/env node
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Command } from "commander";
import {
  DEFAULT_CONFIG,
  VERSION,
  DEFAULT_BOT_NAME,
  DEFAULT_RECALL_BASE_URL,
  CONSENT_MESSAGE,
  type MexCallConfig,
} from "./config.js";
import { ClaudeCodeBrain } from "./brain/ClaudeCodeBrain.js";
import { MeetingMemory } from "./memory/MeetingMemory.js";
import { detectMexScaffold, MEX_NUDGE } from "./memory/scaffold.js";
import { SimulatedTranscriptSource } from "./transport/SimulatedTranscriptSource.js";
import { PassiveLoop } from "./loops/PassiveLoop.js";
import { finalizeCall } from "./finalize.js";
import { loadEnv } from "./util/env.js";
import { RecallTransport, type RecallBotSession } from "./recall/RecallTransport.js";
import { Participants } from "./recall/Participants.js";

const log = (msg: string) => process.stderr.write(`[mex-call] ${msg}\n`);

const program = new Command();
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
      summaryTargetWords: DEFAULT_CONFIG.summaryTargetWords,
      brainTimeoutMs: DEFAULT_CONFIG.brainTimeoutMs,
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

    const brain = new ClaudeCodeBrain({ model: config.summarizerModel, timeoutMs: config.brainTimeoutMs });
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
  .description("Join a Google Meet via Recall, listen, and write live memory (MVP 1 — no actions yet).")
  .argument("<meet-url>", "Google Meet link")
  .option("-n, --name <name>", "call name, used for the archived folder", "meet-call")
  .option("-b, --bot-name <name>", "bot display name shown in the meeting", DEFAULT_BOT_NAME)
  .option("-r, --repo <dir>", "repo whose .mex/meetings/ to write into", process.cwd())
  .option("-c, --compact <ms>", "ms between rolling-summary compactions", String(DEFAULT_CONFIG.compactionIntervalMs))
  .option("-m, --model <alias>", "Claude model alias for compaction", DEFAULT_CONFIG.summarizerModel)
  .option("-w, --window <chars>", "size trigger for the unsummarized window", String(DEFAULT_CONFIG.windowMaxChars))
  .option("-p, --port <port>", "local webhook port (0 = OS-assigned)", "8080")
  .option("--provider <p>", "transcript provider: recallai_streaming | meeting_captions", "recallai_streaming")
  .action(async (meetUrl: string, opts) => {
    const repoRoot = resolve(opts.repo);
    loadEnv(resolve(repoRoot, ".env"));
    loadEnv(resolve(process.cwd(), ".env"));

    const apiKey = process.env.RECALL_API_KEY;
    if (!apiKey) {
      log("RECALL_API_KEY is not set. Add it to .env (RECALL_API_KEY=...) or the environment.");
      process.exit(1);
    }
    const baseUrl = process.env.RECALL_API_URL || DEFAULT_RECALL_BASE_URL;

    const config: MexCallConfig = {
      repoRoot,
      callName: opts.name,
      windowMaxChars: Number(opts.window),
      compactionIntervalMs: Number(opts.compact),
      summarizerModel: opts.model,
      summaryTargetWords: DEFAULT_CONFIG.summaryTargetWords,
      brainTimeoutMs: DEFAULT_CONFIG.brainTimeoutMs,
    };

    const mex = detectMexScaffold(repoRoot);
    if (mex.present) log(`mex scaffold detected (${mex.reason}) — richer context available in later MVPs.`);
    else process.stderr.write(MEX_NUDGE + "\n");

    const memory = new MeetingMemory(repoRoot);
    memory.init();
    log(`writing memory to ${memory.liveDir}`);

    const brain = new ClaudeCodeBrain({ model: config.summarizerModel, timeoutMs: config.brainTimeoutMs });
    const loop = new PassiveLoop(memory, brain, config, { onLog: log });
    const participants = new Participants();

    const transport = new RecallTransport({
      apiKey,
      baseUrl,
      port: Number(opts.port),
      transcriptProvider: opts.provider === "meeting_captions" ? "meeting_captions" : "recallai_streaming",
      log,
    });

    let session: RecallBotSession | undefined;
    try {
      session = await transport.join(meetUrl, { botName: opts.botName });
    } catch (err) {
      log(`failed to join: ${(err as Error).message}`);
      process.exit(1);
    }

    // Wire listeners immediately so we don't miss early events.
    session.onTranscript((chunk) => loop.ingest(chunk));
    session.onParticipantChange((ev) => {
      if (participants.applyAndChanged(ev)) memory.writeParticipants(participants.render());
    });

    let finalizing = false;
    const finalize = async (reason: string) => {
      if (finalizing) return;
      finalizing = true;
      log(`finalizing (${reason})…`);
      await loop.stop();
      const { archivePath } = await finalizeCall(memory, brain, config, log);
      log(`archived call → ${archivePath}`);
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
        } catch (err) {
          log(`consent message failed: ${(err as Error).message}`);
        }
      })
      .catch((err: unknown) => log(`waiting for join: ${(err as Error).message}`));

    log("listening… (Ctrl-C makes the bot leave and archives the call)");
  });

program.parseAsync(process.argv).catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
