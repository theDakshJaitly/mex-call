import { readFileSync } from "node:fs";
import type { TranscriptChunk, TranscriptSource } from "../types.js";

/**
 * MVP 0 transcript feed: reads a text file line-by-line on a timer to simulate
 * a live, speaker-attributed stream. Emits TranscriptChunks identical in shape
 * to what Recall will produce, so the passive loop is unaware it's simulated.
 *
 * Line format: "Speaker: what they said". A line without "Name:" is attributed
 * to the previous speaker (continuation). Blank lines and "# comments" skipped.
 */
export class SimulatedTranscriptSource implements TranscriptSource {
  private readonly lines: { speaker: string; text: string }[];
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private idx = 0;
  private transcriptCb: ((chunk: TranscriptChunk) => void) | null = null;
  private endCb: (() => void) | null = null;

  constructor(filePath: string, opts: { intervalMs: number }) {
    this.intervalMs = opts.intervalMs;
    this.lines = parseTranscriptFile(readFileSync(filePath, "utf8"));
  }

  get lineCount(): number {
    return this.lines.length;
  }

  onTranscript(cb: (chunk: TranscriptChunk) => void): void {
    this.transcriptCb = cb;
  }

  onEnd(cb: () => void): void {
    this.endCb = cb;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.idx >= this.lines.length) {
      void this.stop();
      this.endCb?.();
      return;
    }
    const { speaker, text } = this.lines[this.idx++]!;
    this.transcriptCb?.({ speaker, text, timestampMs: Date.now(), isFinal: true });
  }
}

const SPEAKER_RE = /^([A-Za-z0-9 _.'\-]{1,40}):\s*(.*)$/;

export function parseTranscriptFile(raw: string): { speaker: string; text: string }[] {
  const out: { speaker: string; text: string }[] = [];
  let lastSpeaker = "Unknown";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(SPEAKER_RE);
    if (m) {
      lastSpeaker = m[1]!.trim();
      const text = m[2]!.trim();
      if (text) out.push({ speaker: lastSpeaker, text });
    } else {
      out.push({ speaker: lastSpeaker, text: trimmed });
    }
  }
  return out;
}
