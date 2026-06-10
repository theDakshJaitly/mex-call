import type { TranscriptChunk, ParticipantEvent } from "../types.js";

/**
 * Parsers for Recall realtime webhook payloads. Recall wraps events as
 *   { "event": "transcript.data", "data": { "data": { ... }, "bot": {...} } }
 * We dig defensively (data.data vs data) so a minor shape change doesn't crash
 * the listener — robustness over cleverness (rule 6).
 */

export interface RecallWebhookPayload {
  event?: string;
  data?: any;
}

interface RecallParticipant {
  id?: number | string;
  name?: string | null;
}

function inner(payload: RecallWebhookPayload): any {
  // Most realtime events nest the real body under data.data.
  return payload?.data?.data ?? payload?.data ?? {};
}

function speakerName(p: RecallParticipant | undefined): string {
  const name = p?.name?.trim();
  if (name) return name;
  if (p?.id != null) return `Speaker ${p.id}`;
  return "Unknown";
}

/** transcript.data (finalized) / transcript.partial_data → a TranscriptChunk. */
export function parseTranscriptEvent(payload: RecallWebhookPayload): TranscriptChunk | null {
  if (payload.event !== "transcript.data" && payload.event !== "transcript.partial_data") {
    return null;
  }
  const body = inner(payload);
  const words: Array<{ text?: string }> = Array.isArray(body.words) ? body.words : [];
  const text =
    typeof body.text === "string" && body.text.trim()
      ? body.text.trim()
      : words
          .map((w) => (typeof w.text === "string" ? w.text : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

  if (!text) return null;

  return {
    speaker: speakerName(body.participant),
    text,
    timestampMs: Date.now(), // receipt time; near-real-time and enough for our clock lines
    isFinal: payload.event === "transcript.data",
  };
}

const PARTICIPANT_EVENT_TYPES: Record<string, ParticipantEvent["type"]> = {
  "participant_events.join": "join",
  "participant_events.leave": "leave",
  "participant_events.update": "update",
};

/** participant_events.join / leave / update → a ParticipantEvent. */
export function parseParticipantEvent(payload: RecallWebhookPayload): ParticipantEvent | null {
  const type = payload.event ? PARTICIPANT_EVENT_TYPES[payload.event] : undefined;
  if (!type) return null;
  const body = inner(payload);
  const name = speakerName(body.participant);
  if (name === "Unknown") return null;
  return { type, name, timestampMs: Date.now() };
}
