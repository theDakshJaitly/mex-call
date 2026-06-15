/**
 * Client for AssemblyAI Universal-Streaming v3 (`wss://streaming.assemblyai.com/v3/ws`).
 * We open this OUTBOUND socket and push 16 kHz mono S16LE PCM frames (the exact format
 * Recall delivers), priming the engine with `keyterms_prompt` (e.g. "Mex").
 *
 * Uses the `ws` package (already a dep for the audio server) rather than Node's built-in
 * WebSocket because AssemblyAI v3 requires the API key in an `Authorization` HEADER — the
 * WHATWG built-in can't set request headers, but `ws` can.
 *
 * Wire protocol (verified against AssemblyAI docs + live errors):
 * - Auth: `Authorization: <api-key>` header (NOT a query param).
 * - Config is query params: sample_rate, encoding=pcm_s16le, format_turns, speech_model,
 *   keyterms_prompt (comma-separated).
 * - Audio is sent as RAW BINARY PCM frames (50–1000 ms each), not JSON/base64.
 * - The server sends JSON messages; `type:"Turn"` carries `transcript` (text) and
 *   `end_of_turn` (finality). Begin/Termination/Error are surfaced via the log.
 */
import WebSocket, { type RawData } from "ws";

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
 * Build the streaming connection URL with config query params (no secret — the API key
 * goes in the Authorization header). Pure → offline-testable.
 */
export function buildStreamingUrl(o: AssemblyAiClientOptions): string {
  const u = new URL(STREAMING_URL);
  u.searchParams.set("sample_rate", String(o.sampleRate ?? DEFAULT_SAMPLE_RATE));
  u.searchParams.set("encoding", "pcm_s16le");
  u.searchParams.set("format_turns", String(o.formatTurns ?? true));
  u.searchParams.set("speech_model", o.speechModel ?? DEFAULT_SPEECH_MODEL);
  // keyterms_prompt is a JSON-encoded array (e.g. ["Mex"]) — NOT comma-separated.
  if (o.keyterms?.length) u.searchParams.set("keyterms_prompt", JSON.stringify(o.keyterms));
  return u.toString();
}

/**
 * Parse an AssemblyAI server message into a transcript update. Returns null for
 * non-Turn messages (Begin/Termination/Error) and unparseable input. Pure → testable.
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

/**
 * One streaming session. Open with start(), feed PCM with sendAudio(), receive turns via
 * the onTurn callback, end with stop(). Audio sent before the socket opens is buffered
 * (bounded) so we never drop the first words of an utterance.
 */
export class AssemblyAiStreamingClient {
  private ws: WebSocket | null = null;
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
    const url = buildStreamingUrl(this.opts);
    this.log(`connecting: ${url}`);
    const ws = new WebSocket(url, { headers: { Authorization: this.opts.apiKey } });
    this.ws = ws;

    ws.on("open", () => {
      this.opened = true;
      this.log(`connected (flushing ${this.pending.length} buffered frame(s))`);
      for (const frame of this.pending) ws.send(frame);
      this.pending = [];
    });
    ws.on("message", (data: RawData) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString() : data.toString();
      const turn = parseAssemblyMessage(text);
      if (turn) {
        this.onTurn(turn);
        return;
      }
      // Non-Turn (Begin / Termination / Error) — surface for debugging. AssemblyAI
      // explains a rejection here before closing, so don't swallow it.
      this.log(`msg: ${text.slice(0, 300)}`);
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.opened = false;
      this.closed = true;
      const r = reason?.length ? `: ${reason.toString()}` : "";
      this.log(`closed${code ? ` (${code})` : ""}${r}`);
    });
    ws.on("error", (err: Error) => this.log(`socket error: ${err.message}`));
  }

  /** Feed one PCM frame (16-bit LE, the configured sample rate). */
  sendAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    if (this.opened && this.ws && this.ws.readyState === WebSocket.OPEN) {
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
