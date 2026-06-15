import { RateLimiter, SerialQueue, sleep } from "../util/RateLimiter.js";

/**
 * Thin REST wrapper over the Recall.ai bot API with rate limiting and retries
 * baked in (the user asked for proper rate limiting — it lives here so every
 * call path is covered).
 *
 * Limits (Recall, per workspace): create-bot 120/min, retrieve 300/min. We set
 * conservative token buckets below those, plus a separate serialized queue for
 * chat with a minimum gap so we never flood the meeting. On HTTP 429 we honor
 * the Retry-After header; 5xx/network get exponential backoff.
 */

export interface RecallClientOptions {
  apiKey: string;
  /** e.g. https://us-west-2.recall.ai — region-specific, defaults set by caller. */
  baseUrl: string;
  maxRetries?: number;
  /** Override the default rate limits if needed. */
  limits?: Partial<RecallLimits>;
}

export interface RecallLimits {
  /** Bot creation. Recall allows 120/min; we stay well under. */
  createPerMin: number;
  /** General GET/POST (retrieve, leave, …). Recall allows 300/min. */
  generalPerMin: number;
  /** Chat messages/min — kept low to avoid spamming the meeting. */
  chatPerMin: number;
  /** Minimum gap between chat messages, ms. */
  chatMinGapMs: number;
}

const DEFAULT_LIMITS: RecallLimits = {
  createPerMin: 60,
  generalPerMin: 120,
  chatPerMin: 20,
  chatMinGapMs: 2_000,
};

export interface CreateBotOptions {
  meetingUrl: string;
  botName: string;
  webhookUrl: string;
  transcriptProvider: "recallai_streaming" | "meeting_captions" | "assembly_ai_v3_streaming";
  languageCode: string;
  events: string[];
  /**
   * Terms to bias the STT engine toward (assembly_ai_v3_streaming only → AssemblyAI
   * `keyterms_prompt`). This is the CORRECT spelling we want surfaced (e.g. "Mex") —
   * the opposite of the WAKE_WORDS alias list, which matches the mis-hearings after
   * the fact. Ignored by the other providers.
   */
  keyterms?: string[];
  /**
   * When set, stream raw MIXED audio to this websocket URL instead of having Recall
   * transcribe — used by the native AssemblyAI SttSource. Recall connects to this URL
   * and pushes `audio_mixed_raw.data`. No transcript provider is configured in this mode.
   */
  audioWsUrl?: string;
  /** Optional camera-tile image (base64 JPEG) shown in the participant list. */
  avatar?: { kind: "jpeg"; b64Data: string };
}

export interface RecallBot {
  id: string;
  status: string;
  raw: any;
}

/**
 * Build the Create-Bot request body. Pure (no I/O) so the provider/keyterms mapping
 * is assertable offline via `npx tsx` without hitting Recall (CLAUDE.md test pattern).
 */
export function buildBotBody(opts: CreateBotOptions): Record<string, unknown> {
  const avatarOutput = opts.avatar
    ? {
        automatic_video_output: {
          in_call_recording: { kind: opts.avatar.kind, b64_data: opts.avatar.b64Data },
          in_call_not_recording: { kind: opts.avatar.kind, b64_data: opts.avatar.b64Data },
        },
      }
    : {};

  // Native STT: stream mixed audio to our websocket; no Recall transcription. Keep the
  // webhook for participant events. Otherwise: Recall transcribes via the chosen provider.
  const recording_config = opts.audioWsUrl
    ? {
        audio_mixed_raw: {},
        realtime_endpoints: [
          // Native mode configures NO transcript artifact, so the webhook must not
          // subscribe to transcript.* events (Recall 400s otherwise) — participant events only.
          { type: "webhook", url: opts.webhookUrl, events: opts.events.filter((e) => !e.startsWith("transcript")) },
          { type: "websocket", url: opts.audioWsUrl, events: ["audio_mixed_raw.data"] },
        ],
      }
    : {
        transcript: {
          provider: transcriptProviderConfig(opts),
          diarization: { use_separate_streams_when_available: true },
        },
        realtime_endpoints: [{ type: "webhook", url: opts.webhookUrl, events: opts.events }],
      };

  return {
    meeting_url: opts.meetingUrl,
    bot_name: opts.botName,
    ...avatarOutput,
    recording_config,
  };
}

/** The provider-specific block under recording_config.transcript.provider. */
function transcriptProviderConfig(opts: CreateBotOptions): Record<string, unknown> {
  switch (opts.transcriptProvider) {
    case "meeting_captions":
      return { meeting_captions: {} };
    case "assembly_ai_v3_streaming":
      // keyterms_prompt biases AssemblyAI Universal-Streaming toward our terms ("Mex").
      // Omit the key when empty so we never send `keyterms_prompt: []`.
      return {
        assembly_ai_v3_streaming: opts.keyterms?.length ? { keyterms_prompt: opts.keyterms } : {},
      };
    case "recallai_streaming":
    default:
      return { recallai_streaming: { mode: "prioritize_low_latency", language_code: opts.languageCode } };
  }
}

type Limiter = "create" | "general";

export class RecallClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly maxRetries: number;
  private readonly createLimiter: RateLimiter;
  private readonly generalLimiter: RateLimiter;
  private readonly chatLimiter: RateLimiter;
  private readonly chatQueue: SerialQueue;

  constructor(opts: RecallClientOptions) {
    if (!opts.apiKey) throw new Error("RecallClient: apiKey is required (set RECALL_API_KEY).");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.headers = {
      Authorization: `Token ${opts.apiKey}`,
      "Content-Type": "application/json",
    };
    this.maxRetries = opts.maxRetries ?? 5;
    const limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.createLimiter = new RateLimiter(Math.max(1, limits.createPerMin / 6), limits.createPerMin / 60);
    this.generalLimiter = new RateLimiter(Math.max(1, limits.generalPerMin / 6), limits.generalPerMin / 60);
    this.chatLimiter = new RateLimiter(Math.max(1, Math.ceil(limits.chatPerMin / 10)), limits.chatPerMin / 60);
    this.chatQueue = new SerialQueue(limits.chatMinGapMs);
  }

  async createBot(opts: CreateBotOptions): Promise<RecallBot> {
    const json = await this.request("POST", "/api/v1/bot/", buildBotBody(opts), "create");
    return toBot(json);
  }

  async getBot(botId: string): Promise<RecallBot> {
    const json = await this.request("GET", `/api/v1/bot/${botId}/`, undefined, "general");
    return toBot(json);
  }

  /** Make the bot leave the call. */
  async leaveCall(botId: string): Promise<void> {
    await this.request("POST", `/api/v1/bot/${botId}/leave_call/`, {}, "general");
  }

  /**
   * Send a chat message. Routed through the serialized chat queue (min-gap) AND
   * a token bucket, so bursts are spaced out rather than dropped.
   */
  async sendChatMessage(botId: string, message: string, opts: { pin?: boolean; to?: string } = {}): Promise<void> {
    const text = message.slice(0, 4096); // Recall hard limit is 1–4096 chars
    await this.chatQueue.run(async () => {
      await this.chatLimiter.acquire();
      await this.request(
        "POST",
        `/api/v1/bot/${botId}/send_chat_message/`,
        { message: text, pin: opts.pin ?? false, ...(opts.to ? { to: opts.to } : {}) },
        "skip" // limiter already acquired above
      );
    });
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    limiter: Limiter | "skip"
  ): Promise<any> {
    const url = this.baseUrl + path;
    let attempt = 0;

    for (;;) {
      if (limiter === "create") await this.createLimiter.acquire();
      else if (limiter === "general") await this.generalLimiter.acquire();

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: this.headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt++ >= this.maxRetries) throw new Error(`Recall ${method} ${path} network error: ${(err as Error).message}`);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        if (attempt++ >= this.maxRetries) throw new Error(`Recall ${method} ${path} rate limited (429) after ${this.maxRetries} retries`);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }

      if (res.status >= 500) {
        if (attempt++ >= this.maxRetries) throw new Error(`Recall ${method} ${path} -> ${res.status} after ${this.maxRetries} retries`);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Recall ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
      }

      if (res.status === 204) return null;
      const raw = await res.text();
      return raw ? JSON.parse(raw) : null;
    }
  }
}

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s, 4s, … capped at 30s, with jitter.
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

/** Current status from either the modern status_changes[] array or a status field. */
function toBot(json: any): RecallBot {
  const changes = Array.isArray(json?.status_changes) ? json.status_changes : [];
  const latest = changes.length ? changes[changes.length - 1] : null;
  const status: string = latest?.code ?? json?.status?.code ?? json?.status ?? "unknown";
  return { id: json?.id, status, raw: json };
}
