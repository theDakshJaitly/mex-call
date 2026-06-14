import { sleep } from "../util/RateLimiter.js";

/**
 * Thin REST wrapper over the Vexa bot API with retries/backoff. Vexa's published
 * rate limits are not as tightly specified as Recall's, so we keep this lean —
 * retry on 429/5xx/network with exponential backoff, honor Retry-After. Auth is
 * the `X-API-Key` header. The WebSocket (live transcripts) is handled separately
 * in VexaTransport; this covers create / chat / delete only.
 */
export interface VexaClientOptions {
  apiKey: string;
  /** e.g. https://api.cloud.vexa.ai (hosted) or http://localhost:8056 (self-host). */
  baseUrl: string;
  maxRetries?: number;
}

export interface VexaCreateBotOptions {
  platform: string;
  nativeMeetingId: string;
  botName?: string;
  languageCode?: string;
}

export class VexaClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly maxRetries: number;

  constructor(opts: VexaClientOptions) {
    if (!opts.apiKey) throw new Error("VexaClient: apiKey is required (set VEXA_API_KEY).");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.headers = { "X-API-Key": opts.apiKey, "Content-Type": "application/json" };
    this.maxRetries = opts.maxRetries ?? 5;
  }

  /** POST /bots — request a bot for the meeting. */
  async createBot(o: VexaCreateBotOptions): Promise<void> {
    await this.request("POST", "/bots", {
      platform: o.platform,
      native_meeting_id: o.nativeMeetingId,
      ...(o.botName ? { bot_name: o.botName } : {}),
      ...(o.languageCode ? { language: o.languageCode } : {}),
      transcription_tier: "realtime",
      // HARD no-voice invariant: mex-call output is chat + files + repo actions,
      // never speech. Vexa's interactive voice agent must never be enabled. We set
      // this explicitly (not relying on the API default) so it can't regress.
      voice_agent_enabled: false,
    });
  }

  /** POST /bots/{platform}/{native_meeting_id}/chat — send a chat message. No pin
   * capability exists in Vexa; the message simply posts. */
  async sendChat(platform: string, nativeMeetingId: string, text: string): Promise<void> {
    await this.request("POST", `/bots/${platform}/${encodeURIComponent(nativeMeetingId)}/chat`, {
      text: text.slice(0, 4096),
    });
  }

  /** DELETE /bots/{platform}/{native_meeting_id} — make the bot leave. */
  async deleteBot(platform: string, nativeMeetingId: string): Promise<void> {
    await this.request("DELETE", `/bots/${platform}/${encodeURIComponent(nativeMeetingId)}`, undefined);
  }

  private async request(method: string, path: string, body: unknown): Promise<unknown> {
    const url = this.baseUrl + path;
    let attempt = 0;

    for (;;) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: this.headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt++ >= this.maxRetries) throw new Error(`Vexa ${method} ${path} network error: ${(err as Error).message}`);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        if (attempt++ >= this.maxRetries) throw new Error(`Vexa ${method} ${path} -> ${res.status} after ${this.maxRetries} retries`);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Vexa ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
      }

      if (res.status === 204) return null;
      const raw = await res.text();
      return raw ? JSON.parse(raw) : null;
    }
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}
