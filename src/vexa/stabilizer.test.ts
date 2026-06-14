/**
 * Unit tests for the Vexa segment stabilizer — the load-bearing, genuinely-new
 * logic of the Vexa adapter. Because neither a live Vexa call nor a recorded
 * fixture is easy to drive here, THESE TESTS are the substitute for live-testing
 * §3a: synthetic segment-revision sequences exercised against a deterministic
 * injected clock.
 *
 * Run:  npx tsx src/vexa/stabilizer.test.ts
 * (Not bundled by tsup — only cli.ts/index.ts are entries — but typechecked.)
 */
import { SegmentStabilizer, parseTimestamp, type VexaSegment } from "./stabilizer.js";
import type { TranscriptChunk } from "../types.js";

let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`ok   — ${name}`);
  } else {
    failures++;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function seg(start: string, text: string, extra: Partial<VexaSegment> = {}): VexaSegment {
  return { absolute_start_time: start, text, ...extra };
}
const texts = (cs: TranscriptChunk[]): string[] => cs.map((c) => c.text);
const D = 1000; // debounce for tests

// 1. Segment appears → revised twice → stabilizes → emitted EXACTLY ONCE (final text).
{
  const s = new SegmentStabilizer({ debounceMs: D });
  s.ingest([seg("t1", "Hello", { updated_at: "2025-01-01T00:00:01Z" })], 0);
  eq("revise: nothing before debounce", texts(s.drainStable(500)), []);
  s.ingest([seg("t1", "Hello world", { updated_at: "2025-01-01T00:00:02Z" })], 600);
  eq("revise: still nothing (timer reset on revision)", texts(s.drainStable(1000)), []);
  eq("revise: emits final text once debounced", texts(s.drainStable(1700)), ["Hello world"]);
  eq("revise: never re-emitted", texts(s.drainStable(5000)), []);
}

// 2. Empty / whitespace-only text is discarded.
{
  const s = new SegmentStabilizer({ debounceMs: D });
  s.ingest([seg("t1", "   "), seg("t2", "")], 0);
  eq("empty text dropped", texts(s.drainStable(5000)), []);
}

// 3. updated_at precedence: a strictly-older update is ignored; newer is kept.
{
  const s = new SegmentStabilizer({ debounceMs: D });
  s.ingest([seg("t1", "new", { updated_at: "2025-01-01T00:00:05Z" })], 0);
  s.ingest([seg("t1", "stale", { updated_at: "2025-01-01T00:00:02Z" })], 100);
  eq("updated_at precedence keeps newer text", texts(s.drainStable(2000)), ["new"]);
}

// 4. Two overlapping speakers: both emit, ordered by start time.
{
  const s = new SegmentStabilizer({ debounceMs: D });
  s.ingest([seg("t1", "hi", { speaker: "Alice" }), seg("t2", "yo", { speaker: "Bob" })], 0);
  const out = s.drainStable(2000);
  eq("two speakers: ordered texts", texts(out), ["hi", "yo"]);
  eq("two speakers: attributed", out.map((c) => c.speaker), ["Alice", "Bob"]);
}

// 4b. Supersession is speaker-scoped: a different speaker's later segment does NOT
//     prematurely finalize this speaker's earlier one.
{
  const s = new SegmentStabilizer({ debounceMs: D });
  s.ingest([seg("t1", "a", { speaker: "Alice" }), seg("t2", "b", { speaker: "Bob" })], 0);
  eq("cross-speaker does not supersede before debounce", texts(s.drainStable(200)), []);
}

// 5. Later same-speaker segment supersedes the earlier one → earlier emits
//    immediately (before its debounce); the latest waits for debounce.
{
  const s = new SegmentStabilizer({ debounceMs: D });
  s.ingest([seg("t1", "first", { speaker: "Alice", updated_at: "2025-01-01T00:00:01Z" })], 0);
  s.ingest([seg("t2", "second", { speaker: "Alice", updated_at: "2025-01-01T00:00:02Z" })], 100);
  eq("supersede: earlier emitted immediately", texts(s.drainStable(200)), ["first"]);
  eq("supersede: latest waits for debounce", texts(s.drainStable(1200)), ["second"]);
}

// 6. Reconnect re-sends already-emitted history → no duplicate emission.
{
  const s = new SegmentStabilizer({ debounceMs: D });
  s.ingest([seg("t1", "hi", { updated_at: "2025-01-01T00:00:01Z" })], 0);
  eq("reconnect: initial emit", texts(s.drainStable(2000)), ["hi"]);
  s.ingest([seg("t1", "hi", { updated_at: "2025-01-01T00:00:01Z" })], 2100); // history replay
  eq("reconnect: no duplicate", texts(s.drainStable(4000)), []);
}

// 7. Timestamp parsing + speaker fallback.
{
  const s = new SegmentStabilizer({ debounceMs: D });
  s.ingest([seg("2025-01-15T10:30:05Z", "x")], 0);
  const [c] = s.drainStable(2000);
  ok("timestamp: ISO → epoch ms", c!.timestampMs === Date.parse("2025-01-15T10:30:05Z"));
  eq("speaker: missing → Unknown", c!.speaker, "Unknown");
  eq("isFinal always true", c!.isFinal, true);
}
{
  ok("parseTimestamp: bad string falls back to a finite number", Number.isFinite(parseTimestamp("not-a-date")));
  ok("parseTimestamp: undefined falls back", Number.isFinite(parseTimestamp(undefined)));
}

if (failures) {
  console.error(`\n${failures} stabilizer test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall stabilizer tests passed");
}
