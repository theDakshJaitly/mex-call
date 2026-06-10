import type { Brain } from "../brain/Brain.js";
import type { MeetingMemory } from "../memory/MeetingMemory.js";
import type { MexCallConfig } from "../config.js";
import type { TranscriptChunk } from "../types.js";
import type { MexScaffoldStatus } from "../memory/scaffold.js";
import { buildActivePrompt, type ActiveOutput } from "../prompts.js";
import { detectWake } from "./wake.js";
import { readMexContext } from "./mexContext.js";

export interface ActiveLoopDeps {
  /** How the bot replies — wired to the transport's pinned-capable chat send. */
  sendChatMessage: (text: string, opts?: { pinned?: boolean }) => Promise<void>;
  repoRoot: string;
  mexStatus: MexScaffoldStatus;
  /** Live participant roster text, for context. */
  getParticipants?: () => string;
  log?: (msg: string) => void;
}

/**
 * The active loop. Only fires on the wake phrase ("Mex, …") in a finalized
 * transcript chunk. It runs ALONGSIDE the passive loop — it never pauses
 * listening/writing; they only share the same MeetingMemory.
 *
 * Invocations are serialized on a chain so two "Mex, …" lines can't run
 * overlapping Claude calls (and chat sends are rate-limited downstream).
 */
export class ActiveLoop {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly memory: MeetingMemory,
    private readonly brain: Brain,
    private readonly config: MexCallConfig,
    private readonly deps: ActiveLoopDeps
  ) {}

  /** Inspect a finalized chunk; enqueue a response if the wake word is present. */
  consider(chunk: TranscriptChunk): void {
    if (!chunk.isFinal) return;
    const { hit, utterance } = detectWake(chunk.text);
    if (!hit) return;
    this.log(`wake heard from ${chunk.speaker}: "${truncate(utterance, 100)}"`);
    this.chain = this.chain.catch(() => {}).then(() => this.handle(utterance, chunk.speaker));
  }

  private async handle(utterance: string, speaker: string): Promise<void> {
    try {
      const repoContext = readMexContext(this.deps.repoRoot, this.deps.mexStatus);
      const prompt = buildActivePrompt({
        utterance,
        speaker,
        rollingSummary: this.memory.readSummary(),
        window: this.memory.readWindow(),
        participants: this.deps.getParticipants?.() ?? "",
        decisions: this.memory.readDecisions(),
        actionItems: this.memory.readActionItems(),
        openQuestions: this.memory.readOpenQuestions(),
        repoContext,
      });

      const raw = await this.brain.run(prompt, {
        model: this.config.activeModel,
        timeoutMs: this.config.brainTimeoutMs,
      });

      const out = parseActive(raw);
      if (!out) {
        this.log("active: could not parse model output — staying silent");
        return;
      }
      if (!out.addressed) {
        this.log("wake heard but not actually addressed — staying silent");
        return;
      }

      // Record before replying, so the confirmation is truthful.
      if (out.action === "log_decision" && out.item) this.memory.appendDecisions([out.item]);
      else if (out.action === "log_action_item" && out.item) this.memory.appendActionItems([out.item]);
      else if (out.action === "log_open_question" && out.item) this.memory.appendOpenQuestions([out.item]);

      const message = out.message.trim();
      if (message) {
        await this.deps.sendChatMessage(message, { pinned: false });
        this.log(`replied (${out.action}): ${truncate(message, 80)}`);
      } else {
        this.log(`action ${out.action} with no message — nothing posted`);
      }
    } catch (err) {
      this.log(`active invocation failed: ${(err as Error).message}`);
      try {
        await this.deps.sendChatMessage("Mex hit an error handling that — mind repeating it?");
      } catch {
        /* chat may be unavailable; already logged */
      }
    }
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Tolerant JSON extraction (same approach as the passive loop). */
export function parseActive(raw: string): ActiveOutput | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const action = obj.action;
    const validActions = ["answer", "log_decision", "log_action_item", "log_open_question", "none"];
    return {
      addressed: obj.addressed === true,
      action: validActions.includes(action) ? action : "none",
      item: typeof obj.item === "string" ? obj.item.trim() : "",
      message: typeof obj.message === "string" ? obj.message.trim() : "",
    };
  } catch {
    return null;
  }
}
