import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import type { AudioFrame } from "../types.js";
import type { RecallWebhookPayload } from "./events.js";

/**
 * Decode a Recall realtime-audio websocket message into a PCM frame. Recall sends
 * JSON `{ event, data: { data: { buffer: <base64 PCM>, ... }, participant?: {...} } }`
 * for `audio_mixed_raw.data` / `audio_separate_raw.data`. Returns null for non-audio
 * or malformed messages. Pure → offline-testable.
 */
export function parseAudioMessage(raw: string): AudioFrame | null {
  let msg: { event?: string; data?: { data?: { buffer?: unknown }; participant?: { name?: unknown } } };
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (msg?.event !== "audio_mixed_raw.data" && msg?.event !== "audio_separate_raw.data") return null;
  const buffer = msg.data?.data?.buffer;
  if (typeof buffer !== "string") return null;
  const speaker = typeof msg.data?.participant?.name === "string" ? msg.data.participant.name : undefined;
  return { pcm: new Uint8Array(Buffer.from(buffer, "base64")), speaker };
}

/**
 * Minimal HTTP server that receives Recall's realtime webhook POSTs. Recall
 * pushes transcript.data / participant_events.* to a single URL; in dev that URL
 * is an ngrok tunnel to this server (see tunnel.ts).
 *
 * The webhook path includes a random secret so a stray POST to the public
 * tunnel can't inject fake transcript events.
 */
export class RealtimeServer {
  readonly path: string;
  /** WS path Recall streams raw audio to (native STT). Same secret, different route. */
  readonly audioPath: string;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private handler: ((payload: RecallWebhookPayload) => void) | null = null;
  private audioHandler: ((frame: AudioFrame) => void) | null = null;

  constructor(secret = randomBytes(12).toString("hex")) {
    this.path = `/realtime/${secret}`;
    this.audioPath = `/realtime-audio/${secret}`;
  }

  onEvent(cb: (payload: RecallWebhookPayload) => void): void {
    this.handler = cb;
  }

  /** Subscribe to raw audio frames (native STT). Enables the audio WS on start(). */
  onAudio(cb: (frame: AudioFrame) => void): void {
    this.audioHandler = cb;
  }

  /** Start listening on `port` (0 = an OS-assigned free port). Returns the port. */
  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.route(req, res));
      this.server.on("error", reject);
      // Audio (native STT): Recall opens a WS to audioPath on this same server/tunnel.
      this.wss = new WebSocketServer({ noServer: true });
      this.server.on("upgrade", (req, socket, head) => {
        if (req.url === this.audioPath) {
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            ws.on("message", (data: Buffer) => {
              const frame = parseAudioMessage(data.toString());
              if (frame && this.audioHandler) this.audioHandler(frame);
            });
          });
        } else {
          socket.destroy();
        }
      });
      this.server.listen(port, () => {
        const addr = this.server!.address();
        this.port = typeof addr === "object" && addr ? addr.port : port;
        resolve(this.port);
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  async stop(): Promise<void> {
    this.wss?.close();
    this.wss = null;
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method !== "POST" || req.url !== this.path) {
      res.writeHead(404);
      res.end();
      return;
    }

    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 5_000_000) req.destroy(); // guard against absurd payloads
    });
    req.on("end", () => {
      // Always 200 quickly — Recall retries on non-2xx, and a parse error on our
      // side shouldn't make it hammer us. We swallow bad payloads instead.
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      try {
        const payload = JSON.parse(raw) as RecallWebhookPayload;
        this.handler?.(payload);
      } catch {
        /* ignore malformed payloads */
      }
    });
    req.on("error", () => {
      try {
        res.writeHead(400);
        res.end();
      } catch {
        /* response may already be sent */
      }
    });
  }
}
