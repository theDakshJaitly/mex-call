import type { MeetingTransport, BotSession, TransportStatus } from "../transport/MeetingTransport.js";
import type { TranscriptChunk, ParticipantEvent } from "../types.js";
import { VexaClient } from "./VexaClient.js";
import { SegmentStabilizer, type VexaSegment } from "./stabilizer.js";
import { parseGoogleMeetId, type NativeMeeting } from "./meetingId.js";
import { getWebSocketCtor, WS_OPEN, type WSLike } from "./ws.js";
import {
  DEFAULT_VEXA_BASE_URL,
  VEXA_DRAIN_INTERVAL_MS,
  VEXA_PING_INTERVAL_MS,
  VEXA_SEGMENT_STABILIZE_MS,
} from "../config.js";
import { sleep } from "../util/RateLimiter.js";

export interface VexaTransportOptions {
  apiKey: string;
  /** Defaults to the hosted base; set to a self-host URL otherwise. */
  baseUrl?: string;
  languageCode?: string;
  log?: (msg: string) => void;
}

/** http(s)://host → ws(s)://host/ws. ("https" → "wss" falls out of replacing the
 * leading "http"; "http" → "ws".) */
function deriveWsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/^http/i, "ws") + "/ws";
}

/** Vexa (open-source Recall alternative) implementation of MeetingTransport. */
export class VexaTransport implements MeetingTransport {
  private readonly client: VexaClient;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly languageCode: string;
  private readonly log: (msg: string) => void;

  constructor(o: VexaTransportOptions) {
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl ?? DEFAULT_VEXA_BASE_URL).replace(/\/+$/, "");
    this.client = new VexaClient({ apiKey: o.apiKey, baseUrl: this.baseUrl });
    this.languageCode = o.languageCode ?? "en";
    this.log = o.log ?? (() => {});
  }

  async join(meetingUrl: string, opts: { botName: string }): Promise<VexaBotSession> {
    // Fail fast on a runtime without a built-in WebSocket, before we create a bot
    // whose transcripts we couldn't stream.
    getWebSocketCtor();
    const meeting = parseGoogleMeetId(meetingUrl);

    await this.client.createBot({
      platform: meeting.platform,
      nativeMeetingId: meeting.nativeId,
      botName: opts.botName,
      languageCode: this.languageCode,
    });
    this.log(`vexa bot requested for ${meeting.platform}/${meeting.nativeId}`);

    // api_key is a query param (Vexa's WS auth; its own browser client does this).
    const wsUrl = `${deriveWsUrl(this.baseUrl)}?api_key=${encodeURIComponent(this.apiKey)}`;
    return new VexaBotSession(this.client, meeting, wsUrl, this.log);
  }
}

const ENDED_STATUSES = new Set(["completed", "failed"]);

/** Map Vexa's `meeting.status` values to the vendor-neutral TransportStatus. */
function mapVexaStatus(raw: string): TransportStatus {
  switch (raw) {
    case "awaiting_admission":
      return "waiting_room";
    case "active":
      return "in_call"; // Vexa has no separate recording sub-state
    case "stopping":
    case "completed":
      return "ended";
    case "failed":
      return "failed";
    // requested / joining / connecting / anything not-yet-in-call
    default:
      return "joining";
  }
}

export class VexaBotSession implements BotSession {
  private transcriptCb: ((c: TranscriptChunk) => void) | null = null;
  private participantCb: ((p: ParticipantEvent) => void) | null = null;
  private endCb: (() => void) | null = null;
  private statusCb: ((status: TransportStatus) => void) | null = null;

  private readonly stabilizer = new SegmentStabilizer({ debounceMs: VEXA_SEGMENT_STABILIZE_MS });
  /** Speakers we've already surfaced as a synthetic join (presence-only roster). */
  private readonly seenSpeakers = new Set<string>();

  private ws: WSLike | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private leaving = false;
  private inCall = false;
  private ended = false;
  private reconnectAttempts = 0;

  private inCallResolve: (() => void) | null = null;
  private readonly inCallPromise: Promise<void>;

  constructor(
    private readonly client: VexaClient,
    private readonly meeting: NativeMeeting,
    private readonly wsUrl: string,
    private readonly log: (msg: string) => void
  ) {
    this.inCallPromise = new Promise((resolve) => (this.inCallResolve = resolve));
    this.connect();
    this.drainTimer = setInterval(() => this.drain(), VEXA_DRAIN_INTERVAL_MS);
    this.pingTimer = setInterval(() => this.ping(), VEXA_PING_INTERVAL_MS);
  }

  // --- BotSession interface ---------------------------------------------------

  onTranscript(cb: (c: TranscriptChunk) => void): void {
    this.transcriptCb = cb;
  }
  onParticipantChange(cb: (p: ParticipantEvent) => void): void {
    this.participantCb = cb;
  }
  onCallEnd(cb: () => void): void {
    this.endCb = cb;
  }
  onStatus(cb: (status: TransportStatus) => void): void {
    this.statusCb = cb;
  }

  async sendChatMessage(text: string, _opts: { pinned?: boolean } = {}): Promise<void> {
    // Vexa has no pin capability; `pinned` is intentionally ignored. The bot's
    // visible, clearly-automated participant tile carries the disclosure, so the
    // announcement just needs to post once (the runtime posts it on join).
    await this.client.sendChat(this.meeting.platform, this.meeting.nativeId, text);
  }

  whenInCall(timeoutMs = 180_000): Promise<void> {
    return Promise.race([
      this.inCallPromise,
      sleep(timeoutMs).then(() => {
        if (!this.inCall) throw new Error(`vexa bot did not reach in-call within ${timeoutMs}ms`);
      }),
    ]);
  }

  async leave(): Promise<void> {
    this.leaving = true;
    this.clearTimers();
    this.drain(); // flush whatever's already stable before we go
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.client.deleteBot(this.meeting.platform, this.meeting.nativeId);
    } catch (err) {
      this.log(`vexa delete_bot failed (continuing): ${(err as Error).message}`);
    }
  }

  // --- WebSocket --------------------------------------------------------------

  private connect(): void {
    let ws: WSLike;
    try {
      ws = new (getWebSocketCtor())(this.wsUrl);
    } catch (err) {
      this.log(`vexa ws connect failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.log("vexa ws open — subscribing");
      this.send({
        action: "subscribe",
        meetings: [{ platform: this.meeting.platform, native_id: this.meeting.nativeId }],
      });
    });
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("error", () => this.log("vexa ws error"));
    ws.addEventListener("close", () => {
      if (this.leaving || this.ended) return;
      this.log("vexa ws closed — reconnecting");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.leaving || this.ended) return;
    const attempt = ++this.reconnectAttempts;
    if (attempt > 10) {
      this.log("vexa ws giving up after 10 reconnect attempts");
      return;
    }
    const delay = Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
    setTimeout(() => {
      if (!this.leaving && !this.ended) this.connect();
    }, delay);
  }

  private send(obj: unknown): void {
    try {
      if (this.ws && this.ws.readyState === WS_OPEN) this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.log(`vexa ws send failed: ${(err as Error).message}`);
    }
  }

  private ping(): void {
    this.send({ action: "ping" });
  }

  private onMessage(data: unknown): void {
    let msg: { type?: string; payload?: { segments?: VexaSegment[]; status?: string } };
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // ignore non-JSON frames
    }

    switch (msg.type) {
      case "transcript.mutable": {
        const segments = Array.isArray(msg.payload?.segments) ? msg.payload!.segments! : [];
        if (segments.length) {
          this.stabilizer.ingest(segments, Date.now());
          this.markInCall(); // receiving transcript means we're definitely in the call
        }
        return;
      }
      case "meeting.status": {
        const raw = msg.payload?.status;
        if (!raw) return;
        const status = mapVexaStatus(raw);
        this.statusCb?.(status);
        if (raw === "active") this.markInCall();
        if (ENDED_STATUSES.has(raw)) this.markEnded();
        return;
      }
      case "subscribed":
      case "pong":
        return;
      case "error":
        this.log(`vexa ws error message: ${JSON.stringify((msg as Record<string, unknown>).error ?? msg)}`);
        return;
      default:
        return;
    }
  }

  // --- Stabilized transcript → loops -----------------------------------------

  private drain(): void {
    const chunks = this.stabilizer.drainStable(Date.now());
    for (const chunk of chunks) {
      this.surfaceSpeaker(chunk.speaker, chunk.timestampMs);
      this.transcriptCb?.(chunk);
    }
  }

  /**
   * Vexa emits no participant join/leave events, so the roster is synthesized
   * from observed speakers: the first time a real name speaks we surface a join.
   * Presence-only — leaves are undetectable, which is harmless (nothing keys on
   * live presence). Decoupled from consent (which posts once on join, no re-post).
   */
  private surfaceSpeaker(name: string, timestampMs: number): void {
    if (!name || name === "Unknown") return;
    if (this.seenSpeakers.has(name)) return;
    this.seenSpeakers.add(name);
    this.participantCb?.({ type: "join", name, timestampMs });
  }

  // --- lifecycle --------------------------------------------------------------

  private markInCall(): void {
    if (this.inCall) return;
    this.inCall = true;
    this.inCallResolve?.();
  }

  private markEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.drain(); // flush any remaining stable segments before finalize
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.endCb?.();
  }

  private clearTimers(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
