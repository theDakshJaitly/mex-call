/**
 * The single "brain" abstraction. Implementations shell out to a headless coding
 * agent (Claude Code or Codex) — there is no API key. Latency is tuned per call,
 * not per brain: the active reply runs on a fast model (config.activeModel) since
 * the meeting watches the chat wait, while passive compaction can take its time.
 *
 * MVP 0 uses it for the passive loop's compaction + detection (pure text in,
 * JSON out). MVP 2+ will use the same brain — with tools/repo access — for the
 * active loop. Keeping it behind an interface lets us swap the invocation
 * mechanism (headless CLI now, Agent SDK later) without touching the loops.
 */
export interface Brain {
  /**
   * Run a single, self-contained invocation. Returns the model's text output.
   * Implementations must not throw on empty output; callers handle "".
   */
  run(prompt: string, opts?: BrainRunOptions): Promise<string>;
}

export interface BrainRunOptions {
  /** Model alias (e.g. "sonnet", "opus"). Defaults to the brain's config. */
  model?: string;
  /** Hard timeout for the invocation. */
  timeoutMs?: number;
  /** Appended to the system prompt for this call. */
  appendSystemPrompt?: string;
}
