export const VERSION = "0.5.0";

/** The bot/brand/wake phrase. Deliberately fixed — do not rename (see build doc). */
export const WAKE_WORD = "mex";

/**
 * Wake matches. "Mex" is an uncommon word that live STT routinely mishears, so
 * we also trigger on its frequent mis-transcriptions and let the brain's
 * `addressed` judgement reject anything not actually directed at the bot.
 *
 * WAKE_WORDS match anywhere in the utterance (word-boundary). LEADING_WAKE_WORDS
 * are generic words ("next") that we only treat as the wake word when they START
 * the utterance — since "Mex, …" is always said first — so mid-sentence "what's
 * next" doesn't fire, but a misheard "next, summarize…" does.
 */
export const WAKE_WORDS = ["mex", "max", "mix", "mux", "mecks", "meks", "macks", "maex"];
export const LEADING_WAKE_WORDS = ["next", "nex"];

/**
 * Terms fed to AssemblyAI's `keyterms_prompt` (the `assembly_ai_v3_streaming` STT
 * provider) to bias the engine toward the CORRECT spelling of the wake word. This is
 * the inverse of WAKE_WORDS: we boost what we WANT transcribed ("Mex"), not the
 * mis-hearings we tolerate. Override per call with `--keyterms`.
 */
export const ASSEMBLY_KEYTERMS = ["Mex"];

export interface MexCallConfig {
  /** Repo the conversation is about. Memory is written under <repoRoot>/.mex/meetings/. */
  repoRoot: string;
  /** Used to name the archived call folder: <date>-<callName>. */
  callName: string;
  /**
   * Size trigger for the unsummarized window, in characters. When the window
   * passes this, the loop compacts immediately rather than waiting for the
   * timer — keeping the model input bounded (rule 5) without dropping content.
   */
  windowMaxChars: number;
  /** How often the passive loop recompacts the rolling summary. */
  compactionIntervalMs: number;
  /** Model alias for passive compaction/detection. */
  summarizerModel: string;
  /** Model alias for the active loop (user-facing replies on the wake phrase). */
  activeModel: string;
  /** Model alias for the tool-enabled action brain (in-call repo actions). */
  actionModel: string;
  /** Soft target length for the rolling summary, in words. Keeps it bounded. */
  summaryTargetWords: number;
  /** Per-call timeout for brain invocations. */
  brainTimeoutMs: number;
  /** Per-call timeout for the action brain — agentic repo work needs longer. */
  actionTimeoutMs: number;
}

export const DEFAULT_CONFIG: Omit<MexCallConfig, "repoRoot" | "callName"> = {
  windowMaxChars: 4_000,
  compactionIntervalMs: 45_000,
  summarizerModel: "sonnet",
  // Active replies are on the latency hot path, BUT benchmarking showed haiku is
  // not the win it looked like: warm, end-to-end it ran ~40% SLOWER than sonnet
  // (~5.9s vs ~4.2s) because the fixed per-`claude -p` overhead dominates and
  // haiku's output wasn't quicker. sonnet is also the stronger classifier (more
  // reliable `repo_action` routing on messy live transcripts). So the active loop
  // stays on sonnet; the real latency lever is elsewhere — spawn overhead +
  // STT/transport, which `--timings` exists to expose. Override per call with
  // --active-model.
  activeModel: "sonnet",
  actionModel: "sonnet",
  summaryTargetWords: 350,
  brainTimeoutMs: 120_000,
  actionTimeoutMs: 300_000,
};

/** Tools the action brain may use, in the repo, for in-call actions (MVP 4). */
export const ACTION_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Bash(gh *)",
  "Bash(git *)",
];

// --- Recall / meeting transport (MVP 1) --------------------------------------

/**
 * Bot display name. Doubles as consent ("notetaker" is descriptive) and brand
 * exposure — every participant sees "Mex" in the room. The wake word stays "Mex"
 * regardless of any future product name.
 */
export const DEFAULT_BOT_NAME = "Mex (notetaker)";

/** Region-specific Recall base URL. Override with RECALL_API_URL. */
export const DEFAULT_RECALL_BASE_URL = "https://us-west-2.recall.ai";

/** Realtime webhook events we subscribe to. Partials are skipped (we act on finals). */
export const RECALL_REALTIME_EVENTS = [
  "transcript.data",
  "participant_events.join",
  "participant_events.leave",
  "participant_events.update",
];

export interface SttResolution {
  /** Use our own in-process AssemblyAI client (native path). */
  nativeStt: boolean;
  /** Recall's transcript provider when NOT native. */
  recallProvider: "recallai_streaming" | "meeting_captions" | "assembly_ai_v3_streaming";
  /** Nudge the user that setting ASSEMBLYAI_API_KEY would improve accuracy. */
  nudgeSetKey: boolean;
}

/**
 * Resolve which STT to use for a Recall call. Pure → offline-testable.
 *
 * Default (no `--provider`): native AssemblyAI when ASSEMBLYAI_API_KEY is set — much
 * better wake-word ("Mex") + general accuracy — otherwise Recall's recallai_streaming.
 * Explicit `--provider` always wins: `native` (own client), `assembly` (Recall-managed
 * AssemblyAI), `meeting_captions`, or `recallai_streaming`.
 */
export function resolveStt(provider: string | undefined, hasAssemblyKey: boolean): SttResolution {
  const nativeStt = provider === "native" || (!provider && hasAssemblyKey);
  const recallProvider =
    provider === "meeting_captions"
      ? "meeting_captions"
      : provider === "assembly"
        ? "assembly_ai_v3_streaming"
        : "recallai_streaming";
  const usingAssembly = nativeStt || recallProvider === "assembly_ai_v3_streaming";
  return { nativeStt, recallProvider, nudgeSetKey: !hasAssemblyKey && !usingAssembly };
}

/**
 * Consent message, posted pinned on join (required — see build doc). Plain text
 * only: Google Meet chat does not render markdown or hyperlinks.
 */
export const CONSENT_MESSAGE =
  "Mex is in the call, listening and turning this conversation into structured notes in your project's repo. " +
  "I don't speak — I reply here in chat. Recording and transcription are active. " +
  'Say "Mex, ..." to ask me to do something.';

// --- Closing / funnel messages (posted once at end of call) ------------------

/**
 * "3 decisions, 2 action items and 1 open question" — natural-language summary
 * of what the call captured, skipping any zero category. Plain text (Meet chat
 * renders no markdown). Returns "" when nothing was captured.
 */
function describeCaptured(decisions: number, actionItems: number, openQuestions: number): string {
  const parts: string[] = [];
  if (decisions) parts.push(`${decisions} decision${decisions === 1 ? "" : "s"}`);
  if (actionItems) parts.push(`${actionItems} action item${actionItems === 1 ? "" : "s"}`);
  if (openQuestions) parts.push(`${openQuestions} open question${openQuestions === 1 ? "" : "s"}`);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

/**
 * Closing message when a mex scaffold IS present: quietly confirm the decisions
 * were logged to the event log and where to review them. Returns "" if nothing
 * was captured (don't post an empty confirmation).
 */
export function mexTimelineConfirmation(decisions: number, actionItems: number, openQuestions: number): string {
  const captured = describeCaptured(decisions, actionItems, openQuestions);
  if (!captured) return "";
  return (
    `Logged ${captured} from this call to your mex timeline (tagged source: meeting). ` +
    'Run "mex timeline" to review them — each is tied back to this call.'
  );
}

/**
 * Closing message when NO mex scaffold is present: the wedge. Name what was
 * captured, name that it's currently going nowhere a coding agent can reach, name
 * the specific unlock, give the one command. Honest because it's literally true
 * of what just happened. Returns "" if nothing was captured.
 */
export function mexSetupWedge(decisions: number, actionItems: number, openQuestions: number): string {
  const captured = describeCaptured(decisions, actionItems, openQuestions);
  if (!captured) return "";
  return (
    `I captured ${captured} from this call, along with the reasoning behind them. ` +
    "Right now they're just notes in your repo that your coding agent never reads. " +
    "With mex, they become a permanent, queryable decision log tied to this repo — " +
    "so your agent can answer why you chose something months from now, not just what the code says today. " +
    'Run "mex-call setup" to wire it in.'
  );
}

// --- Vexa / meeting transport (open-source alternative) ----------------------

/**
 * Hosted Vexa API base. Override with VEXA_API_URL (e.g. http://localhost:8056
 * for self-host). The WebSocket URL is derived from this (http→ws, https→wss)
 * and authenticated with `?api_key=` (Vexa's WS takes the key as a query param,
 * not a header — its own browser client does the same).
 */
export const DEFAULT_VEXA_BASE_URL = "https://api.cloud.vexa.ai";

/**
 * Vexa emits ONLY `transcript.mutable` segments that are re-sent and revised —
 * `transcript.finalized` is deprecated and never emitted, so there is no
 * finality signal. The adapter holds each segment and treats it as final once it
 * has gone this long with no further update (or is superseded by a later
 * same-speaker segment), synthesizing the "one final per utterance" contract the
 * loops require. Generous on purpose: mex-call is no-voice / relaxed-clock, so a
 * couple seconds of stabilization lag is harmless and avoids emitting half-revised
 * text as final.
 */
export const VEXA_SEGMENT_STABILIZE_MS = 2_500;
/** How often the adapter sweeps for newly-stable segments to emit. */
export const VEXA_DRAIN_INTERVAL_MS = 750;
/** Application-level WS keepalive ping interval (Vexa docs recommend ~25s). */
export const VEXA_PING_INTERVAL_MS = 25_000;
