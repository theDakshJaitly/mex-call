/**
 * Core data shapes. These mirror what Recall's realtime transcript gives us
 * (speaker-attributed, partial vs. final) so the MVP 0 simulated source is
 * swap-compatible with the real transport added in MVP 1.
 */

export interface TranscriptChunk {
  /** Real name from diarization when available; "Unknown" otherwise. */
  speaker: string;
  text: string;
  timestampMs: number;
  /** Partial (still being transcribed) vs. finalized. We act on finals. */
  isFinal: boolean;
}

export interface ParticipantEvent {
  type: "join" | "leave" | "update";
  name: string;
  timestampMs: number;
}

/**
 * The minimal surface the passive loop consumes from any transcript producer.
 * Both the MVP 0 SimulatedTranscriptSource and the MVP 1 Recall BotSession
 * satisfy this, so the loops never depend on the transport.
 */
export interface TranscriptSource {
  onTranscript(cb: (chunk: TranscriptChunk) => void): void;
  onParticipantChange?(cb: (p: ParticipantEvent) => void): void;
  /** Fires when the feed is exhausted / the call ends. */
  onEnd(cb: () => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
