import type { TranscriptChunk } from "../types.js";

/**
 * Speech-to-text abstraction. The DEFAULT in MVP 1 is Recall's bundled
 * transcription ($0.15/hr, includes per-speaker diarization) — i.e. the
 * transport already hands us finished TranscriptChunks and no SttSource is
 * needed. This interface exists only so a local Whisper.cpp source can be
 * slotted in later. Do NOT build local STT first.
 *
 * NOTE: not implemented in MVP 0 — contract only.
 */
export interface SttSource {
  onTranscript(cb: (chunk: TranscriptChunk) => void): void;
  /** Feed raw audio frames (PCM) when transcribing locally. */
  pushAudio(frame: Uint8Array, opts: { speaker?: string; timestampMs: number }): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
