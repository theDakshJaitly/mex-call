// Public API surface for mex-call (MVP 0).
export type { TranscriptChunk, ParticipantEvent, TranscriptSource } from "./types.js";
export type { MeetingTransport, BotSession, TransportStatus } from "./transport/MeetingTransport.js";
export type { SttSource } from "./transport/SttSource.js";
export { Participants } from "./transport/Participants.js";
export type { Brain, BrainRunOptions } from "./brain/Brain.js";
export { ClaudeCodeBrain } from "./brain/ClaudeCodeBrain.js";
export { CodexBrain } from "./brain/CodexBrain.js";
export { createBrain, detectAgent, type Agent, type BrainRole } from "./brain/createBrain.js";
export { SimulatedTranscriptSource, parseTranscriptFile } from "./transport/SimulatedTranscriptSource.js";
export { MeetingMemory } from "./memory/MeetingMemory.js";
export { detectMexScaffold, type MexScaffoldStatus } from "./memory/scaffold.js";
export { PassiveLoop } from "./loops/PassiveLoop.js";
export { ActiveLoop, parseActive } from "./active/ActiveLoop.js";
export { detectWake } from "./active/wake.js";
export { readMexContext } from "./active/mexContext.js";
export { finalizeCall } from "./finalize.js";
export { Dashboard, type DashboardMeta } from "./runtime/Dashboard.js";
export {
  DEFAULT_CONFIG,
  VERSION,
  WAKE_WORD,
  DEFAULT_BOT_NAME,
  DEFAULT_RECALL_BASE_URL,
  CONSENT_MESSAGE,
  RECALL_REALTIME_EVENTS,
  type MexCallConfig,
} from "./config.js";

// Recall transport (MVP 1)
export { RecallTransport, RecallBotSession } from "./recall/RecallTransport.js";
export { RecallClient } from "./recall/RecallClient.js";
export { RealtimeServer } from "./recall/RealtimeServer.js";
export { loadAvatar, type BotAvatar } from "./recall/avatar.js";
export { parseTranscriptEvent, parseParticipantEvent } from "./recall/events.js";
export { resolvePublicUrl } from "./recall/tunnel.js";

// Vexa transport (open-source alternative)
export { VexaTransport, VexaBotSession } from "./vexa/VexaTransport.js";
export { VexaClient } from "./vexa/VexaClient.js";
export { SegmentStabilizer, type VexaSegment } from "./vexa/stabilizer.js";
export { parseGoogleMeetId, type NativeMeeting } from "./vexa/meetingId.js";
export { RateLimiter, SerialQueue, sleep } from "./util/RateLimiter.js";
export { loadEnv } from "./util/env.js";
