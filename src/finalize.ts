import type { Brain } from "./brain/Brain.js";
import type { MeetingMemory } from "./memory/MeetingMemory.js";
import type { MexCallConfig } from "./config.js";
import { buildFinalSummaryPrompt } from "./prompts.js";

export interface FinalizeResult {
  archivePath: string;
  archiveName: string;
}

/**
 * Call-end finalize: one last compaction, generate final-summary.md, then
 * archive live/ → .mex/meetings/<date>-<callName>/ and reset live/ for the next
 * call. Robust: if final-summary generation fails we still archive what we have.
 */
export async function finalizeCall(
  memory: MeetingMemory,
  brain: Brain,
  config: MexCallConfig,
  log: (msg: string) => void = () => {}
): Promise<FinalizeResult> {
  const archiveName = `${todayIso()}-${slug(config.callName)}`;

  let finalMarkdown = "";
  try {
    finalMarkdown = await brain.run(
      buildFinalSummaryPrompt({
        callName: config.callName,
        rollingSummary: memory.readSummary(),
        decisions: memory.readDecisions(),
        actionItems: memory.readActionItems(),
        openQuestions: memory.readOpenQuestions(),
      }),
      { model: config.summarizerModel, timeoutMs: config.brainTimeoutMs }
    );
  } catch (err) {
    log(`final summary generation failed: ${(err as Error).message} — archiving without it`);
  }

  const archivePath = memory.archiveLive(archiveName);
  if (finalMarkdown.trim()) {
    memory.writeFinalSummary(archivePath, finalMarkdown);
  }

  return { archivePath, archiveName };
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
