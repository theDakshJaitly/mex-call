import { isAbsolute } from "node:path";
import { appendEvent, createConfig } from "mex-agent";

/**
 * Writes detected call items into mex's EVENT LOG (.mex/events/decisions.jsonl)
 * via the in-process mex-agent API — NEVER the knowledge scaffold (context/,
 * patterns/). The scaffold is the agent's ground truth about what the code IS;
 * a meeting decision ("we'll switch auth to OAuth next sprint") is history, not
 * code-state, so writing it into the scaffold would poison that ground truth.
 * The event log answers "what happened, when, why?" — honest even before the
 * implementation lands. (See EVENT_LOG_FUNNEL brief §0.)
 *
 * In-process on purpose: shelling out to `mex log` spawns a Node cold-start and
 * blocks on a telemetry network-flush (~800ms) per call — invisible in dev, but
 * a dozen decisions at end-of-call would be ~10s of idle blocking for users.
 */

/**
 * mex-call's three detected categories → mex event kinds. `kind` is a CLOSED
 * gate in mex's reader (only decision|note|risk|todo survive `readEvents`), so
 * the "this came from a meeting" provenance lives in `source`/`status`, never in
 * `kind`. `status` is free-form (unvalidated) but persisted.
 */
const EVENT_GROUPS = [
  { key: "decisions", kind: "decision", status: "decided" },
  { key: "actionItems", kind: "todo", status: "open" },
  { key: "openQuestions", kind: "note", status: "open" },
] as const;

export interface WriteMeetingEventsInput {
  /** Target repo root (the repo the meeting is about, where .mex/ lives). ABSOLUTE. */
  projectRoot: string;
  /** That repo's .mex/ dir. ABSOLUTE. */
  scaffoldRoot: string;
  /** Provenance pointer to the finalized meeting archive (repo-relative path). */
  trace: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
}

export interface MeetingEventCounts {
  decisions: number;
  actionItems: number;
  openQuestions: number;
  total: number;
}

/**
 * Append each detected item as a typed event with `source: "meeting"` and a
 * `trace` back to the call it came from. Returns per-category counts. Call this
 * ONCE per call (at finalize, from the deduped lists) — there is no dedup in the
 * event log, so writing the same decision mid-call and again at finalize would
 * double-log.
 */
export function writeMeetingEvents(input: WriteMeetingEventsInput): MeetingEventCounts {
  // projectRoot invariant: appendEvent normalizes files/cwd against projectRoot,
  // so it MUST be the target repo's root — not mex-call's install dir (which may
  // be global). Getting this wrong works in testing and breaks in production.
  if (!isAbsolute(input.projectRoot) || !isAbsolute(input.scaffoldRoot)) {
    throw new Error(
      `writeMeetingEvents: projectRoot and scaffoldRoot must be absolute (got "${input.projectRoot}", "${input.scaffoldRoot}")`
    );
  }
  const config = createConfig({ projectRoot: input.projectRoot, scaffoldRoot: input.scaffoldRoot });

  const counts: MeetingEventCounts = { decisions: 0, actionItems: 0, openQuestions: 0, total: 0 };
  for (const group of EVENT_GROUPS) {
    for (const raw of input[group.key]) {
      const message = raw.trim();
      if (!message) continue;
      appendEvent(config, message, {
        kind: group.kind,
        source: "meeting",
        status: group.status,
        trace: input.trace,
      });
      counts[group.key]++;
      counts.total++;
    }
  }
  return counts;
}
