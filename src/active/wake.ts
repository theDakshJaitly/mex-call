import { WAKE_WORDS, LEADING_WAKE_WORDS } from "../config.js";

// Word-boundary, case-insensitive match for the wake word (and its common STT
// mis-hearings) in finalized text. Deliberately simple (no real-time wake
// engine): a 1–2s transcription delay is fine because output is written. False
// positives (e.g. "the mex tool", or a person actually named Max) are filtered
// downstream by the brain's `addressed` judgement.
const ANYWHERE_RE = new RegExp(`\\b(?:${WAKE_WORDS.join("|")})\\b`, "i");
// Generic mis-hears: only a wake hit when they START the utterance.
const LEADING_RE = new RegExp(`^\\W*(?:${LEADING_WAKE_WORDS.join("|")})\\b`, "i");

export interface WakeHit {
  hit: boolean;
  /** The full utterance that contained the wake word. */
  utterance: string;
}

export function detectWake(text: string): WakeHit {
  const t = (text ?? "").trim();
  if (!t) return { hit: false, utterance: "" };
  if (ANYWHERE_RE.test(t) || LEADING_RE.test(t)) return { hit: true, utterance: t };
  return { hit: false, utterance: "" };
}
