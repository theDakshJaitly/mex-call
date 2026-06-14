import type { Brain } from "../brain/Brain.js";
import type { MeetingMemory } from "../memory/MeetingMemory.js";
import type { MexCallConfig } from "../config.js";
import type { TranscriptChunk } from "../types.js";
import type { MexScaffoldStatus } from "../memory/scaffold.js";
import { buildActivePrompt, buildActionPrompt, ACTIVE_REPLY_SYSTEM_PROMPT, type ActiveOutput } from "../prompts.js";
import { detectWake } from "./wake.js";
import { readMexContext, readMexEventHistory } from "./mexContext.js";

export interface ActiveLoopDeps {
  /** How the bot replies — wired to the transport's pinned-capable chat send. */
  sendChatMessage: (text: string, opts?: { pinned?: boolean }) => Promise<void>;
  repoRoot: string;
  mexStatus: MexScaffoldStatus;
  /** Live participant roster text, for context. */
  getParticipants?: () => string;
  log?: (msg: string) => void;
  /** Structured feed for the live dashboard (icon + text). */
  onActivity?: (icon: string, text: string) => void;
  /**
   * Tool-enabled brain for in-call repo actions (MVP 4): a `claude -p` running
   * in the repo with gh/git/Write/Edit. Omit to disable repo actions.
   */
  actionBrain?: Brain;
  /**
   * When set, log a per-stage latency breakdown for every "Mex, …" reply
   * (queue wait, context read, classifier brain, action brain, chat send). Lets
   * a CLI/dev run see whether the wall-clock is the brain or the transport — see
   * the `--timings` flag. No effect on behaviour.
   */
  timings?: boolean;
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
  /** Piece C: the "with mex you'd get repo-wide history" note is shown at most once per call. */
  private ceilingShown = false;

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
    this.deps.onActivity?.("🎙", `${chunk.speaker}: "${truncate(utterance, 80)}"`);
    // enqueuedAt is captured BEFORE the chain wait, so the breakdown can show how
    // long a reply sat behind an in-flight one (serialization, not the brain).
    const enqueuedAt = Date.now();
    this.chain = this.chain.catch(() => {}).then(() => this.handle(utterance, chunk.speaker, enqueuedAt));
  }

  /** Emit a one-line latency breakdown (only when --timings is on). Auto-totals. */
  private timing(parts: Record<string, number>): void {
    if (!this.deps.timings) return;
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    const body = Object.entries(parts).map(([k, v]) => `${k}=${v}ms`).join("  ");
    this.log(`[timing] ${body}  total≈${total}ms`);
  }

  private async handle(utterance: string, speaker: string, enqueuedAt: number): Promise<void> {
    const tStart = Date.now();
    const queueWait = tStart - enqueuedAt;
    try {
      const repoContext = readMexContext(this.deps.repoRoot, this.deps.mexStatus);
      const repoHistory = readMexEventHistory(this.deps.repoRoot, this.deps.mexStatus);
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
        repoHistory,
      });
      const tPrompt = Date.now();

      const raw = await this.brain.run(prompt, {
        model: this.config.activeModel,
        timeoutMs: this.config.brainTimeoutMs,
        appendSystemPrompt: ACTIVE_REPLY_SYSTEM_PROMPT,
      });
      const tClassify = Date.now();
      const base = { queueWait, context: tPrompt - tStart, classify: tClassify - tPrompt };

      const out = parseActive(raw);
      if (!out) {
        this.log("active: could not parse model output — staying silent");
        this.timing(base);
        return;
      }
      if (!out.addressed) {
        this.log("wake heard but not actually addressed — staying silent");
        this.timing(base);
        return;
      }

      // Record before replying, so the confirmation is truthful.
      if (out.action === "log_decision" && out.item) this.memory.appendDecisions([out.item]);
      else if (out.action === "log_action_item" && out.item) this.memory.appendActionItems([out.item]);
      else if (out.action === "log_open_question" && out.item) this.memory.appendOpenQuestions([out.item]);
      if (out.action.startsWith("log_") && out.item) {
        this.deps.onActivity?.("📝", `logged ${out.action.replace("log_", "").replace("_", " ")}: ${truncate(out.item, 70)}`);
      }

      if (out.action === "repo_action") {
        await this.handleRepoAction(out.item, base);
        return;
      }

      const message = this.withCeilingNote(out.action, utterance, out.message.trim());
      if (message) {
        const tBeforeSend = Date.now();
        await this.deps.sendChatMessage(message, { pinned: false });
        this.timing({ ...base, chatSend: Date.now() - tBeforeSend });
        this.log(`replied (${out.action}): ${truncate(message, 80)}`);
        this.deps.onActivity?.("✅", `replied: ${truncate(message, 80)}`);
      } else {
        this.timing(base);
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

  /** MVP 4: hand the task to the tool-enabled action brain (runs in the repo). */
  private async handleRepoAction(task: string, base: Record<string, number> = {}): Promise<void> {
    if (!this.deps.actionBrain) {
      await this.deps.sendChatMessage("I can't take repo actions in this call (they're turned off).");
      return;
    }
    if (!task.trim()) {
      await this.deps.sendChatMessage("I didn't catch what to do in the repo — say it again?");
      return;
    }
    this.deps.onActivity?.("🔧", `acting on repo: ${truncate(task, 70)}`);
    this.log(`repo action: ${truncate(task, 120)}`);

    const prompt = buildActionPrompt({
      task,
      repoRoot: this.deps.repoRoot,
      rollingSummary: this.memory.readSummary(),
      decisions: this.memory.readDecisions(),
      actionItems: this.memory.readActionItems(),
      participants: this.deps.getParticipants?.() ?? "",
    });

    // May throw (timeout, tool error) — the caller's catch posts a fallback.
    const tAction0 = Date.now();
    const result = await this.deps.actionBrain.run(prompt, {
      model: this.config.actionModel,
      timeoutMs: this.config.actionTimeoutMs,
    });
    const tAction1 = Date.now();

    const message = (result.trim() || "Done.").slice(0, 400);
    await this.deps.sendChatMessage(message, { pinned: false });
    this.timing({ ...base, action: tAction1 - tAction0, chatSend: Date.now() - tAction1 });
    this.deps.onActivity?.("✅", `repo action: ${truncate(message, 80)}`);
    this.log(`repo action done: ${truncate(message, 100)}`);
  }

  /**
   * Piece C: when no mex scaffold is present and the user asks a memory-shaped
   * question, the bot can only answer from THIS call — so it names that ceiling,
   * turning the limitation into a nudge. Kept light: only on plain answers to
   * clearly memory-shaped questions, and at most once per call.
   */
  private withCeilingNote(action: string, utterance: string, message: string): string {
    if (!message || this.ceilingShown) return message;
    if (this.deps.mexStatus.present) return message;
    if (action !== "answer") return message;
    if (!MEMORY_SHAPED.test(utterance)) return message;
    this.ceilingShown = true;
    return (
      message +
      ' — note: that\'s from this call only. With mex set up I\'d answer from this repo\'s whole ' +
      'decision history, not just today. Run "mex-call setup" to wire it in.'
    );
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}

/** Questions about prior decisions/conventions — what the event log would answer. */
const MEMORY_SHAPED =
  /\b(decid\w*|decision|convention|agreed?|why did we|what did we|last time|previously|before|in the past|history)\b/i;

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
    const validActions = ["answer", "log_decision", "log_action_item", "log_open_question", "repo_action", "none"];
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
