/**
 * Client for AssemblyAI Universal-Streaming v3 (`wss://streaming.assemblyai.com/v3/ws`).
 * We open this OUTBOUND socket and push 16 kHz mono S16LE PCM frames (the exact format
 * Recall delivers), priming the engine with `keyterms_prompt` (e.g. "Mex"). Uses Node's
 * built-in WebSocket (Node 22+) — same zero-dep approach as the Vexa transport, so no `ws`
 * package. The Recall AUDIO RECEIVER (Recall connecting to us) is a separate concern that
 * does need a WS server.
 *
 * Wire protocol (verified against AssemblyAI docs):
 * - Auth + config are query params: ApiKey, sample_rate, encoding=pcm_s16le, format_turns,
 *   speech_model, keyterms_prompt (comma-separated).
 * - Audio is sent as RAW BINARY PCM frames (50–1000 ms each), not JSON/base64.
 * - The server sends JSON messages; `type:"Turn"` carries `transcript` (text) and
 *   `end_of_turn` (finality). Begin/Termination/etc. are ignored here.
 */

const STREAMING_URL = "wss://streaming.assemblyai.com/v3/ws";
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_SPEECH_MODEL = "universal-streaming-english";

export interface AssemblyAiClientOptions {
  apiKey: string;
  /** PCM sample rate of the frames we send. Recall delivers 16 kHz. */
  sampleRate?: number;
  /** Terms to bias recognition toward → `keyterms_prompt` (e.g. ["Mex"]). */
  keyterms?: string[];
  /** Punctuate/format finalized turns. Default true. */
  formatTurns?: boolean;
  speechModel?: string;
  log?: (msg: string) => void;
}

/** A transcription update from a `Turn` message. */
export interface AssemblyAiTurn {
  text: string;
  /** True once the turn is finalized (end of utterance). */
  endOfTurn: boolean;
}

/**
 * Build the streaming connection URL with all query params. Pure → offline-testable.
 * `ApiKey` is set last so callers can redact everything before it when logging.
 */
export function buildStreamingUrl(o: AssemblyAiClientOptions): string {
  const u = new URL(STREAMING_URL);
  u.searchParams.set("sample_rate", String(o.sampleRate ?? DEFAULT_SAMPLE_RATE));
  u.searchParams.set("encoding", "pcm_s16le");
  u.searchParams.set("format_turns", String(o.formatTurns ?? true));
  u.searchParams.set("speech_model", o.speechModel ?? DEFAULT_SPEECH_MODEL);
  if (o.keyterms?.length) u.searchParams.set("keyterms_prompt", o.keyterms.join(","));
  u.searchParams.set("ApiKey", o.apiKey);
  return u.toString();
}

/** Redact the ApiKey query param for safe logging. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]ApiKey=)[^&]*/i, "$1***");
}

/**
 * Parse an AssemblyAI server message into a transcript update. Returns null for
 * non-Turn messages (Begin/Termination/etc.) and unparseable input. Pure → testable.
 */
export function parseAssemblyMessage(raw: string): AssemblyAiTurn | null {
  let msg: { type?: string; transcript?: unknown; end_of_turn?: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (msg?.type !== "Turn") return null;
  return {
    text: typeof msg.transcript === "string" ? msg.transcript : "",
    endOfTurn: msg.end_of_turn === true,
  };
}

// --- minimal binary-capable WHATWG WebSocket typing (built-in global, Node 22+) ------

interface BinaryWS {
  send(data: ArrayBufferView | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (ev: { data?: unknown; code?: number; reason?: string }) => void
  ): void;
}
type BinaryWSCtor = { new (url: string): BinaryWS };
const WS_OPEN = 1;

function resolveWsCtor(): BinaryWSCtor {
  const ctor = (globalThis as unknown as { WebSocket?: BinaryWSCtor }).WebSocket;
  if (!ctor) {
    throw new Error(
      "Native AssemblyAI STT needs a built-in WebSocket (Node 22+). Upgrade Node, or use a Recall-managed provider (--provider assembly / recallai_streaming)."
    );
  }
  return ctor;
}

/**
 * One streaming session. Open with start(), feed PCM with sendAudio(), receive turns via
 * the onTurn callback, end with stop(). Audio sent before the socket opens is buffered
 * (bounded) so we never drop the first words of an utterance.
 */
export class AssemblyAiStreamingClient {
  private ws: BinaryWS | null = null;
  private opened = false;
  private closed = false;
  /** Frames queued before the socket is open. Bounded to avoid unbounded growth on a stalled connect. */
  private pending: Uint8Array[] = [];
  private static readonly MAX_PENDING = 200; // ~10s at 50ms frames

  constructor(
    private readonly opts: AssemblyAiClientOptions,
    private readonly onTurn: (turn: AssemblyAiTurn) => void
  ) {}

  start(): void {
    const Ctor = resolveWsCtor();
    const url = buildStreamingUrl(this.opts);
    this.log(`connecting: ${redactUrl(url)}`);
    const ws = new Ctor(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.opened = true;
      this.log(`connected (flushing ${this.pending.length} buffered frame(s))`);
      for (const frame of this.pending) ws.send(frame);
      this.pending = [];
    });
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return; // AssemblyAI sends JSON text
      const turn = parseAssemblyMessage(ev.data);
      if (turn) this.onTurn(turn);
    });
    ws.addEventListener("close", (ev) => {
      this.opened = false;
      this.closed = true;
      this.log(`closed${ev.code ? ` (${ev.code})` : ""}`);
    });
    ws.addEventListener("error", () => this.log("socket error"));
  }

  /** Feed one PCM frame (16-bit LE, the configured sample rate). */
  sendAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    if (this.opened && this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(pcm);
    } else if (this.pending.length < AssemblyAiStreamingClient.MAX_PENDING) {
      this.pending.push(pcm);
    }
  }

  stop(): void {
    this.closed = true;
    this.pending = [];
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
  }

  private log(msg: string): void {
    this.opts.log?.(`[assemblyai] ${msg}`);
  }
}
