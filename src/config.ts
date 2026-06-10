export const VERSION = "0.1.0";

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
  /** Soft target length for the rolling summary, in words. Keeps it bounded. */
  summaryTargetWords: number;
  /** Per-call timeout for brain invocations. */
  brainTimeoutMs: number;
}

export const DEFAULT_CONFIG: Omit<MexCallConfig, "repoRoot" | "callName"> = {
  windowMaxChars: 4_000,
  compactionIntervalMs: 45_000,
  summarizerModel: "sonnet",
  activeModel: "sonnet",
  summaryTargetWords: 350,
  brainTimeoutMs: 120_000,
};

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

/**
 * Consent message, posted pinned on join (required — see build doc). Plain text
 * only: Google Meet chat does not render markdown or hyperlinks.
 */
export const CONSENT_MESSAGE =
  "Mex is in the call, listening and turning this conversation into structured notes in your project's repo. " +
  "I don't speak — I reply here in chat. Recording and transcription are active. " +
  'Say "Mex, ..." to ask me to do something.';
