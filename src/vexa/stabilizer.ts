import type { TranscriptChunk } from "../types.js";

/** A transcript segment as delivered inside a Vexa `transcript.mutable` payload. */
export interface VexaSegment {
  text?: string;
  speaker?: string | null;
  language?: string;
  /** ISO 8601 UTC string (canonical). Vexa's browser client also tolerates a number. */
  absolute_start_time?: string | number;
  absolute_end_time?: string | number;
  /** ISO 8601 update time; used for collision precedence when present. */
  updated_at?: string;
}

interface Entry {
  seg: VexaSegment;
  /** Wall-clock ms when this segment was last (re)written — drives the debounce. */
  lastTouchedMs: number;
  emitted: boolean;
}

/**
 * Turns Vexa's upsert-based, never-final segment stream into the append-once,
 * one-final-per-utterance contract the loops require. THIS is the load-bearing
 * part of the Vexa adapter.
 *
 * Vexa re-sends and revises `transcript.mutable` segments; `transcript.finalized`
 * is deprecated and never emitted, so there is no "final" signal. Mapping each
 * mutable segment straight to an isFinal chunk would write the same utterance
 * 3-5× and corrupt the bounded memory. Instead we:
 *
 *   1. Upsert by `absolute_start_time`, keeping the segment with the newer
 *      `updated_at` on collision; drop empty/whitespace text.
 *   2. Emit a segment EXACTLY ONCE, when it becomes "stable": untouched for
 *      `debounceMs`, OR superseded by a later-starting segment from the same
 *      speaker (the earlier one won't change anymore).
 *   3. Never emit the same `absolute_start_time` twice (reconnect re-sends history
 *      idempotently — already-emitted keys are ignored).
 *
 * Pure given an injected clock: `ingest` takes the receipt time and `drainStable`
 * takes "now", so behavior is fully deterministic and unit-testable (no real timers).
 */
export class SegmentStabilizer {
  private readonly debounceMs: number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: { debounceMs: number }) {
    this.debounceMs = opts.debounceMs;
  }

  /** Upsert a batch of segments received at `receivedAtMs` (wall-clock ms). */
  ingest(segments: VexaSegment[], receivedAtMs: number): void {
    for (const seg of segments) {
      const key = segKey(seg);
      const text = (seg.text ?? "").trim();
      if (!key || !text) continue; // need a key for ordering; drop empty text

      const existing = this.entries.get(key);
      if (existing?.emitted) continue; // already final — never revise or re-emit

      // updated_at precedence: when both present, ignore a strictly-older update.
      if (existing?.seg.updated_at && seg.updated_at && seg.updated_at < existing.seg.updated_at) {
        continue;
      }

      this.entries.set(key, { seg, lastTouchedMs: receivedAtMs, emitted: false });
    }
  }

  /** Emit (exactly once) every segment that has become stable as of `nowMs`. */
  drainStable(nowMs: number): TranscriptChunk[] {
    // Highest start key per speaker: a later one means the earlier is settled.
    const maxStartBySpeaker = new Map<string, string>();
    for (const { seg } of this.entries.values()) {
      const sp = speakerKey(seg);
      const start = segKey(seg);
      const cur = maxStartBySpeaker.get(sp);
      if (!cur || start > cur) maxStartBySpeaker.set(sp, start);
    }

    const ready: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.emitted) continue;
      const start = segKey(entry.seg);
      const debounced = nowMs - entry.lastTouchedMs >= this.debounceMs;
      const superseded = (maxStartBySpeaker.get(speakerKey(entry.seg)) ?? start) > start;
      if (debounced || superseded) ready.push(entry);
    }

    ready.sort((a, b) => segKey(a.seg).localeCompare(segKey(b.seg)));

    const out: TranscriptChunk[] = [];
    for (const entry of ready) {
      entry.emitted = true;
      out.push(toChunk(entry.seg));
    }
    return out;
  }
}

/** Map key derived from absolute_start_time (stringified, since it may be numeric). */
function segKey(seg: VexaSegment): string {
  const v = seg.absolute_start_time;
  return v === undefined || v === null ? "" : String(v);
}

function speakerKey(seg: VexaSegment): string {
  return (seg.speaker ?? "").trim();
}

function toChunk(seg: VexaSegment): TranscriptChunk {
  return {
    speaker: (seg.speaker ?? "").trim() || "Unknown",
    text: (seg.text ?? "").trim(),
    timestampMs: parseTimestamp(seg.absolute_start_time),
    isFinal: true,
  };
}

/** ISO 8601 string → epoch ms. Falls back to now() for anything unparseable
 * (timestamps are display-only in mex-call; nothing orders/windows by them). */
export function parseTimestamp(v: string | number | undefined): number {
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}
