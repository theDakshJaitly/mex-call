import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Brain } from "./brain/Brain.js";
import type { MeetingMemory } from "./memory/MeetingMemory.js";
import type { MexCallConfig } from "./config.js";
import { writeMeetingEvents, type MeetingEventCounts } from "./memory/events.js";
import {
  buildFinalSummaryPrompt,
  buildFollowUpEmailPrompt,
  buildProductSignalsPrompt,
  type FinalSummaryInput,
} from "./prompts.js";

export interface FinalizeResult {
  archivePath: string;
  archiveName: string;
  /** How many items were detected this call, by category (for the closing message). */
  detected: MeetingEventCounts;
  /** Counts actually written to the mex event log; only set when `events` was passed. */
  loggedEvents?: MeetingEventCounts;
}

export interface FinalizeOptions {
  /** Also generate follow-up-email.md and product-signals.md (MVP 4). */
  artifacts?: boolean;
  /**
   * When set, also log this call's detected items to mex's event log (Piece A).
   * Provide ONLY when a real mex scaffold is present. Both paths MUST be absolute:
   * the target repo's root and its .mex/ dir.
   */
  events?: { projectRoot: string; scaffoldRoot: string };
}

/**
 * Call-end finalize: generate final-summary.md (and optional post-call
 * artifacts), then archive live/ → .mex/meetings/<date>-<callName>/ and reset
 * live/. Robust: any generation that fails is skipped; we still archive.
 */
export async function finalizeCall(
  memory: MeetingMemory,
  brain: Brain,
  config: MexCallConfig,
  log: (msg: string) => void = () => {},
  opts: FinalizeOptions = {}
): Promise<FinalizeResult> {
  const archiveName = `${todayIso()}-${slug(config.callName)}`;
  const input: FinalSummaryInput = {
    callName: config.callName,
    rollingSummary: memory.readSummary(),
    decisions: memory.readDecisions(),
    actionItems: memory.readActionItems(),
    openQuestions: memory.readOpenQuestions(),
  };

  const gen = async (label: string, prompt: string): Promise<string> => {
    try {
      return await brain.run(prompt, { model: config.summarizerModel, timeoutMs: config.brainTimeoutMs });
    } catch (err) {
      log(`${label} generation failed: ${(err as Error).message} — skipping`);
      return "";
    }
  };

  // Generate while memory is still in live/ (archiveLive moves + resets it).
  const finalMarkdown = await gen("final summary", buildFinalSummaryPrompt(input));
  const followUp = opts.artifacts ? await gen("follow-up email", buildFollowUpEmailPrompt(input)) : "";
  const signals = opts.artifacts ? await gen("product signals", buildProductSignalsPrompt(input)) : "";

  const archivePath = memory.archiveLive(archiveName);
  if (finalMarkdown.trim()) memory.writeFinalSummary(archivePath, finalMarkdown);
  if (followUp.trim()) writeFileSync(join(archivePath, "follow-up-email.md"), followUp.trim() + "\n");
  if (signals.trim()) writeFileSync(join(archivePath, "product-signals.md"), signals.trim() + "\n");

  const detected: MeetingEventCounts = {
    decisions: input.decisions.length,
    actionItems: input.actionItems.length,
    openQuestions: input.openQuestions.length,
    total: input.decisions.length + input.actionItems.length + input.openQuestions.length,
  };

  // Piece A: log to mex's event log when a real scaffold is present. The `trace`
  // is the repo-relative archive path, tying each event back to this call.
  let loggedEvents: MeetingEventCounts | undefined;
  if (opts.events) {
    try {
      loggedEvents = writeMeetingEvents({
        projectRoot: opts.events.projectRoot,
        scaffoldRoot: opts.events.scaffoldRoot,
        trace: relative(opts.events.projectRoot, archivePath),
        decisions: input.decisions,
        actionItems: input.actionItems,
        openQuestions: input.openQuestions,
      });
      log(
        `logged ${loggedEvents.total} event(s) to mex timeline ` +
          `(${loggedEvents.decisions} decisions, ${loggedEvents.actionItems} todos, ${loggedEvents.openQuestions} notes)`
      );
    } catch (err) {
      log(`event-log write failed: ${(err as Error).message} — skipping`);
    }
  }

  return { archivePath, archiveName, detected, loggedEvents };
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "call"
  );
}
