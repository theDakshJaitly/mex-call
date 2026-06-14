import type { MeetingTransport, BotSession, TransportStatus } from "../transport/MeetingTransport.js";
import type { TranscriptChunk, ParticipantEvent } from "../types.js";
import { RecallClient } from "./RecallClient.js";
import { RealtimeServer } from "./RealtimeServer.js";
import { resolvePublicUrl } from "./tunnel.js";
import { parseTranscriptEvent, parseParticipantEvent, type RecallWebhookPayload } from "./events.js";
import { DEFAULT_RECALL_BASE_URL, RECALL_REALTIME_EVENTS } from "../config.js";
import { sleep } from "../util/RateLimiter.js";

export interface RecallTransportOptions {
  apiKey: string;
  baseUrl?: string;
  /** Local port for the webhook server (0 = OS-assigned). */
  port?: number;
  transcriptProvider?: "recallai_streaming" | "meeting_captions";
  languageCode?: string;
  /** Camera-tile image (base64 JPEG). Omit for no custom tile. */
  avatar?: { kind: "jpeg"; b64Data: string };
  log?: (msg: string) => void;
}

/** Recall.ai implementation of MeetingTransport (MVP 1). */
export class RecallTransport implements MeetingTransport {
  private readonly client: RecallClient;
  private readonly opts: Required<
    Omit<RecallTransportOptions, "apiKey" | "baseUrl" | "log" | "avatar">
  > & {
    avatar?: { kind: "jpeg"; b64Data: string };
    log: (msg: string) => void;
  };

  constructor(o: RecallTransportOptions) {
    this.client = new RecallClient({ apiKey: o.apiKey, baseUrl: o.baseUrl ?? DEFAULT_RECALL_BASE_URL });
    this.opts = {
      port: o.port ?? 0,
      transcriptProvider: o.transcriptProvider ?? "recallai_streaming",
      languageCode: o.languageCode ?? "en",
      avatar: o.avatar,
      log: o.log ?? (() => {}),
    };
  }

  async join(meetingUrl: string, opts: { botName: string }): Promise<RecallBotSession> {
    const log = this.opts.log;

    const server = new RealtimeServer();
    const port = await server.start(this.opts.port);
    log(`webhook server listening on :${port}${server.path}`);

    const { url: publicBase, source } = await resolvePublicUrl(port);
    const webhookUrl = publicBase + server.path;
    log(`public webhook (${source}): ${publicBase}${server.path.replace(/\/[^/]+$/, "/…")}`);

    let bot;
    try {
      bot = await this.client.createBot({
        meetingUrl,
        botName: opts.botName,
        webhookUrl,
        transcriptProvider: this.opts.transcriptProvider,
        languageCode: this.opts.languageCode,
        events: RECALL_REALTIME_EVENTS,
        avatar: this.opts.avatar,
      });
    } catch (err) {
      await server.stop();
      throw err;
    }
    log(`bot created: ${bot.id} (status: ${bot.status})`);

    return new RecallBotSession(this.client, server, bot.id, log);
  }
}

const IN_CALL_STATUSES = new Set([
  "in_call_recording",
  "in_call_not_recording",
  "recording_permission_allowed",
]);
const ENDED_STATUSES = new Set(["call_ended", "done", "fatal", "recording_done", "media_expired"]);

/** Map Recall's raw bot-status codes to the vendor-neutral TransportStatus. */
function mapRecallStatus(raw: string): TransportStatus {
  if (raw === "fatal") return "failed";
  if (ENDED_STATUSES.has(raw)) return "ended";
  if (raw === "in_call_recording") return "recording";
  if (raw === "in_waiting_room") return "waiting_room";
  if (IN_CALL_STATUSES.has(raw) || raw.startsWith("in_call")) return "in_call";
  // ready / joining_call / and any not-yet-in-call code
  return "joining";
}

export class RecallBotSession implements BotSession {
  private transcriptCb: ((c: TranscriptChunk) => void) | null = null;
  private participantCb: ((p: ParticipantEvent) => void) | null = null;
  private endCb: (() => void) | null = null;
  private statusCb: ((status: TransportStatus) => void) | null = null;

  private poller: NodeJS.Timeout | null = null;
  private lastStatus = "";
  private inCall = false;
  private ended = false;
  private inCallResolve: (() => void) | null = null;
  private readonly inCallPromise: Promise<void>;

  constructor(
    private readonly client: RecallClient,
    private readonly server: RealtimeServer,
    readonly botId: string,
    private readonly log: (msg: string) => void
  ) {
    this.inCallPromise = new Promise((resolve) => (this.inCallResolve = resolve));
    this.server.onEvent((payload) => this.dispatch(payload));
    this.startPolling();
  }

  // --- BotSession interface ---------------------------------------------------

  onTranscript(cb: (c: TranscriptChunk) => void): void {
    this.transcriptCb = cb;
  }
  onParticipantChange(cb: (p: ParticipantEvent) => void): void {
    this.participantCb = cb;
  }

  async sendChatMessage(text: string, opts: { pinned?: boolean } = {}): Promise<void> {
    // Omit `to` so Recall defaults to everyone (avoids guessing its enum).
    await this.client.sendChatMessage(this.botId, text, { pin: opts.pinned ?? false });
  }

  async leave(): Promise<void> {
    this.stopPolling();
    try {
      await this.client.leaveCall(this.botId);
    } catch (err) {
      this.log(`leave_call failed (continuing): ${(err as Error).message}`);
    }
    await this.server.stop();
  }

  // --- Extras used by the runtime --------------------------------------------

  onCallEnd(cb: () => void): void {
    this.endCb = cb;
  }
  onStatus(cb: (status: TransportStatus) => void): void {
    this.statusCb = cb;
  }
  /** Resolves once the bot is admitted and in the call (so chat sends will work). */
  whenInCall(timeoutMs = 180_000): Promise<void> {
    return Promise.race([
      this.inCallPromise,
      sleep(timeoutMs).then(() => {
        if (!this.inCall) throw new Error(`bot did not reach in-call within ${timeoutMs}ms (last status: ${this.lastStatus})`);
      }),
    ]);
  }

  // --- internals --------------------------------------------------------------

  private dispatch(payload: RecallWebhookPayload): void {
    const transcript = parseTranscriptEvent(payload);
    if (transcript) {
      // Receiving transcript means we're definitely in the call.
      this.markInCall();
      this.transcriptCb?.(transcript);
      return;
    }
    const participant = parseParticipantEvent(payload);
    if (participant) {
      this.markInCall();
      this.participantCb?.(participant);
    }
  }

  private startPolling(): void {
    // Poll bot status to drive lifecycle (consent-on-join, finalize-on-end)
    // without needing the account-level webhook. Retrieve limit is 300/min;
    // every 4s is well under and the RecallClient rate-limits it anyway.
    this.poller = setInterval(() => void this.pollOnce(), 4_000);
  }

  private async pollOnce(): Promise<void> {
    try {
      const bot = await this.client.getBot(this.botId);
      if (bot.status && bot.status !== this.lastStatus) {
        this.lastStatus = bot.status;
        this.log(`bot status: ${bot.status}`);
        // End-detection stays per-adapter and keys on Recall's raw status sets;
        // only the OUTGOING status is normalized so the dashboard never sees
        // Recall's vocabulary.
        this.statusCb?.(mapRecallStatus(bot.status));
        if (IN_CALL_STATUSES.has(bot.status)) this.markInCall();
        if (ENDED_STATUSES.has(bot.status)) this.markEnded();
      }
    } catch (err) {
      this.log(`status poll failed (will retry): ${(err as Error).message}`);
    }
  }

  private markInCall(): void {
    if (this.inCall) return;
    this.inCall = true;
    this.inCallResolve?.();
  }

  private markEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.stopPolling();
    this.endCb?.();
  }

  private stopPolling(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }
}
