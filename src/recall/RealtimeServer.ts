import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { RecallWebhookPayload } from "./events.js";

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
  private server: Server | null = null;
  private port = 0;
  private handler: ((payload: RecallWebhookPayload) => void) | null = null;

  constructor(secret = randomBytes(12).toString("hex")) {
    this.path = `/realtime/${secret}`;
  }

  onEvent(cb: (payload: RecallWebhookPayload) => void): void {
    this.handler = cb;
  }

  /** Start listening on `port` (0 = an OS-assigned free port). Returns the port. */
  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.route(req, res));
      this.server.on("error", reject);
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
