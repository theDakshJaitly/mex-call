import type { Brain } from "../brain/Brain.js";
import type { MeetingMemory } from "../memory/MeetingMemory.js";
import type { MexCallConfig } from "../config.js";
import type { TranscriptChunk } from "../types.js";
import { buildCompactionPrompt, type CompactionOutput } from "../prompts.js";

export interface PassiveLoopEvents {
  onLog?: (msg: string) => void;
  onCompaction?: (out: CompactionOutput) => void;
}

/**
 * The always-on passive loop. No trigger. It accumulates the transcript, and on
 * a timer compacts (window + previous summary) → new summary, shedding detail so
 * the model input never grows with meeting length. This IS the mex homeostatic
 * principle applied live: accumulate → compress → rewrite → shed.
 */
export class PassiveLoop {
  private timer: NodeJS.Timeout | null = null;
  /** Serializes compactions so two never run at once (file writes + shed must be atomic). */
  private chain: Promise<void> = Promise.resolve();
  /** A compaction is already waiting at the tail of the chain — coalesce triggers onto it. */
  private queued = false;
  /** New finalized text since the last compaction — skip the call if nothing changed. */
  private dirty = false;

  constructor(
    private readonly memory: MeetingMemory,
    private readonly brain: Brain,
    private readonly config: MexCallConfig,
    private readonly events: PassiveLoopEvents = {}
  ) {}

  /** Feed one transcript chunk. We act only on finalized text. */
  ingest(chunk: TranscriptChunk): void {
    if (!chunk.isFinal) return;
    this.memory.ingest(chunk);
    this.dirty = true;
    // Size trigger: compact before the unsummarized window can grow large, so a
    // fast burst of speech is folded in rather than sitting unbounded until the
    // timer fires. Lossless because content is only shed after it's summarized.
    if (this.memory.windowChars() >= this.config.windowMaxChars) {
      void this.kick();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.kick(), this.config.compactionIntervalMs);
  }

  /**
   * Stop the timer, drain any in-flight/queued compaction, then run one final
   * forced pass so nothing is left unfolded. Returns only when the window is
   * fully captured — so finalize never races a compaction.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.chain; // let in-flight + queued work settle
    await this.kick({ force: true }); // fold whatever remains
  }

  /**
   * Schedule a compaction on the serial chain. At most one runs and one waits;
   * extra triggers while one is queued are coalesced (the queued pass will see
   * the latest window). A forced pass (call end) is never coalesced away.
   */
  kick(opts: { force?: boolean; reason?: string } = {}): Promise<void> {
    if (this.queued && !opts.force) return this.chain;
    this.queued = true;
    this.chain = this.chain
      .catch(() => {})
      .then(() => {
        this.queued = false;
        return this.doCompact(opts);
      });
    return this.chain;
  }

  /** Recompute the rolling summary, append newly-detected items, shed folded text. */
  private async doCompact(opts: { force?: boolean; reason?: string } = {}): Promise<void> {
    if (!this.dirty && !opts.force) return;
    const snapshot = this.memory.snapshotWindow();
    if (!snapshot.text.trim() && !this.memory.readSummary().trim()) return;

    this.dirty = false;
    try {
      const prompt = buildCompactionPrompt({
        previousSummary: this.memory.readSummary(),
        windowText: snapshot.text,
        existingDecisions: this.memory.readDecisions(),
        existingActionItems: this.memory.readActionItems(),
        existingOpenQuestions: this.memory.readOpenQuestions(),
        targetWords: this.config.summaryTargetWords,
      });

      const raw = await this.brain.run(prompt, {
        model: this.config.summarizerModel,
        timeoutMs: this.config.brainTimeoutMs,
      });

      const out = parseCompaction(raw);
      if (!out) {
        this.log("compaction: could not parse model output, keeping window for retry");
        this.dirty = true; // retry next tick
        return;
      }

      // Lossless guarantee: only shed the window if its content was actually
      // captured in a non-empty summary. Otherwise keep it and retry.
      if (!out.rollingSummary.trim()) {
        this.log("compaction returned empty summary, keeping window for retry");
        this.dirty = true;
        return;
      }

      this.memory.writeSummary(out.rollingSummary);
      this.memory.appendDecisions(out.newDecisions);
      this.memory.appendActionItems(out.newActionItems);
      this.memory.appendOpenQuestions(out.newOpenQuestions);
      this.memory.shedWindow(snapshot.count);

      const counts =
        `summary ${wordCount(out.rollingSummary)}w` +
        `, +${out.newDecisions.length} decisions` +
        `, +${out.newActionItems.length} actions` +
        `, +${out.newOpenQuestions.length} questions`;
      this.log(`compaction ok (${counts})`);
      this.events.onCompaction?.(out);
    } catch (err) {
      this.log(`compaction failed: ${(err as Error).message} — keeping previous summary`);
      this.dirty = true; // retry next tick
    }
  }

  private log(msg: string): void {
    this.events.onLog?.(msg);
  }
}

function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

/** Tolerant JSON extraction: handles stray prose or ```json fences around the object. */
export function parseCompaction(raw: string): CompactionOutput | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1]!.trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      rollingSummary: typeof obj.rollingSummary === "string" ? obj.rollingSummary : "",
      newDecisions: toStringArray(obj.newDecisions),
      newActionItems: toStringArray(obj.newActionItems),
      newOpenQuestions: toStringArray(obj.newOpenQuestions),
    };
  } catch {
    return null;
  }
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}
