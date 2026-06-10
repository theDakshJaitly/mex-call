import { WAKE_WORD } from "../config.js";

// Word-boundary, case-insensitive match for the wake word in finalized text.
// Deliberately simple (no real-time wake engine): a 1–2s transcription delay is
// fine because output is written. False positives (e.g. "the mex tool") are
// filtered downstream by the brain's `addressed` judgement.
const WAKE_RE = new RegExp(`\\b${WAKE_WORD}\\b`, "i");

export interface WakeHit {
  hit: boolean;
  /** The full utterance that contained the wake word. */
  utterance: string;
}

export function detectWake(text: string): WakeHit {
  if (!text || !WAKE_RE.test(text)) return { hit: false, utterance: "" };
  return { hit: true, utterance: text.trim() };
}
