import type { TranscriptChunk, ParticipantEvent, AudioFrame } from "../types.js";

/**
 * Abstracts the meeting bot. Recall is the first implementation (MVP 1); Vexa is
 * the second. Defined first so the loops + runtime are written against the
 * interface, never against a vendor directly — a transport can be swapped
 * without touching the loops or the composition root.
 *
 * The interface is the FULL contract the runtime (`cli.ts join`) depends on,
 * including the lifecycle methods below. (These were once concrete-only
 * "extras" on RecallBotSession; promoting them means a transport missing one
 * fails to typecheck instead of silently never announcing consent / finalizing.)
 */
export interface MeetingTransport {
  join(meetingUrl: string, opts: { botName: string }): Promise<BotSession>;
}

/**
 * Normalized, vendor-neutral lifecycle status. Each adapter maps its own vendor
 * strings into this enum; the dashboard and end-detection consume only this, so
 * no vendor status vocabulary leaks past the adapter.
 */
export type TransportStatus =
  | "joining"
  | "waiting_room"
  | "in_call"
  | "recording"
  | "ended"
  | "failed";

export interface BotSession {
  /** Speaker-attributed realtime transcript. */
  onTranscript(cb: (chunk: TranscriptChunk) => void): void;
  onParticipantChange(cb: (p: ParticipantEvent) => void): void;
  /**
   * Raw audio frames, when the transport streams audio for an in-process STT source
   * (Recall native AssemblyAI). Optional — transports that produce their own transcripts
   * (Vexa) omit it.
   */
  onAudio?(cb: (frame: AudioFrame) => void): void;
  /** Output channel. `pinned` requests persistent visibility to latecomers; a
   * transport without true pinning (e.g. Vexa) honors it via re-posting. */
  sendChatMessage(text: string, opts?: { pinned?: boolean }): Promise<void>;
  leave(): Promise<void>;
  /** Resolves once the bot is admitted and in the call (so chat sends work). */
  whenInCall(timeoutMs?: number): Promise<void>;
  /** Fires once when the call ends — drives finalize/archive. Each adapter
   * derives this from its own vendor signals (Recall: ended statuses; Vexa:
   * status → completed/failed). */
  onCallEnd(cb: () => void): void;
  /** Normalized lifecycle status updates (dashboard badges + end-detection). */
  onStatus(cb: (status: TransportStatus) => void): void;
}
