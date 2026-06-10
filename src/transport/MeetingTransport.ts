import type { TranscriptChunk, ParticipantEvent } from "../types.js";

/**
 * Abstracts the meeting bot. Recall is the first implementation (MVP 1).
 * Defined now (per the build doc: "define these first") so the loops are
 * written against the interface, never against Recall directly. An OSS /
 * self-hosted transport can replace it without touching the loops.
 *
 * NOTE: not implemented in MVP 0 — this file is the contract only.
 */
export interface MeetingTransport {
  join(meetingUrl: string, opts: { botName: string }): Promise<BotSession>;
}

export interface BotSession {
  /** Speaker-attributed realtime transcript. */
  onTranscript(cb: (chunk: TranscriptChunk) => void): void;
  onParticipantChange(cb: (p: ParticipantEvent) => void): void;
  /** Output channel. On Google Meet, `pinned` keeps it visible to latecomers. */
  sendChatMessage(text: string, opts?: { pinned?: boolean }): Promise<void>;
  leave(): Promise<void>;
}
