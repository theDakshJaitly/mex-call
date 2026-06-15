import type { TranscriptChunk } from "../types.js";
import type { SttSource } from "../transport/SttSource.js";
import {
  AssemblyAiStreamingClient,
  type AssemblyAiClientOptions,
  type AssemblyAiTurn,
} from "./AssemblyAiStreamingClient.js";

/** The minimal surface AssemblyAiSttSource needs from a streaming client (real or fake). */
export interface StreamingClient {
  start(): void;
  sendAudio(frame: Uint8Array): void;
  stop(): void;
}

export interface AssemblyAiSttSourceOptions {
  apiKey: string;
  /** Terms to bias toward → keyterms_prompt (e.g. ["Mex"]). */
  keyterms?: string[];
  /** PCM sample rate of incoming frames (Recall delivers 16 kHz). */
  sampleRate?: number;
  log?: (msg: string) => void;
  /** Injectable client factory (defaults to the real AssemblyAI client) — for tests. */
  createClient?: (opts: AssemblyAiClientOptions, onTurn: (turn: AssemblyAiTurn) => void) => StreamingClient;
}

/** Map an AssemblyAI turn to a TranscriptChunk. Pure → offline-testable. */
export function turnToChunk(speaker: string, turn: AssemblyAiTurn, now = Date.now()): TranscriptChunk {
  return {
    speaker: speaker || "Unknown",
    text: turn.text,
    timestampMs: now,
    isFinal: turn.endOfTurn,
  };
}

/**
 * SttSource backed by AssemblyAI Universal-Streaming. Frames arrive via pushAudio
 * tagged with a speaker (per-participant streams, phase 2) or untagged (mixed audio,
 * phase 1). We keep one streaming session PER speaker key, created LAZILY on first
 * audio — so a billed socket is never held open for a silent participant — and tear
 * them all down on stop().
 */
export class AssemblyAiSttSource implements SttSource {
  private cb: ((chunk: TranscriptChunk) => void) | null = null;
  private readonly clients = new Map<string, StreamingClient>();
  private stopped = false;
  private readonly create: NonNullable<AssemblyAiSttSourceOptions["createClient"]>;

  constructor(private readonly opts: AssemblyAiSttSourceOptions) {
    this.create = opts.createClient ?? ((o, onTurn) => new AssemblyAiStreamingClient(o, onTurn));
  }

  onTranscript(cb: (chunk: TranscriptChunk) => void): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    this.stopped = false;
  }

  pushAudio(frame: Uint8Array, opts: { speaker?: string; timestampMs: number }): void {
    if (this.stopped) return;
    const key = opts.speaker ?? "";
    let client = this.clients.get(key);
    if (!client) {
      client = this.create(
        {
          apiKey: this.opts.apiKey,
          keyterms: this.opts.keyterms,
          sampleRate: this.opts.sampleRate,
          log: this.opts.log,
        },
        (turn) => {
          if (turn.text && this.cb) this.cb(turnToChunk(key, turn));
        }
      );
      client.start();
      this.clients.set(key, client);
    }
    client.sendAudio(frame);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }
}
