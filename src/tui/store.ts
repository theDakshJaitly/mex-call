import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The TUI's read-only view of a running call. The runtime is the source of truth;
 * the TUI tails the files Dashboard.ts already writes (zero model cost) and the
 * memory files under .mex/meetings/live/. This module is pure Node (no React) so
 * it's unit-testable against fixture files (see store.test.ts).
 */

/** Mirrors Dashboard.statusObject() — the schema of status.json. */
export interface StatusJson {
  callName: string;
  meetUrl: string;
  botName: string;
  status: string;
  ended: boolean;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  counts: {
    participants: number;
    decisions: number;
    actionItems: number;
    openQuestions: number;
  };
}

export interface TranscriptLine {
  ts: string;
  speaker: string;
  text: string;
  raw: string;
}

export interface ActivityLine {
  ts: string;
  icon: string;
  text: string;
  raw: string;
}

/** Parsed participants.md (Participants.render): who's here vs. who left. */
export interface ParticipantsState {
  present: string[];
  left: string[];
}

/** One wake consideration from wake-log.jsonl — drives the wake-replay view. */
export interface WakeEventRecord {
  ts: number;
  speaker: string;
  utterance: string;
  source: "voice" | "typed";
  addressed: boolean;
  action: string;
  outcome: "addressed" | "ignored" | "error";
}

export interface LiveState {
  /** A live call's files are present (status.json or transcript.md exists). */
  liveExists: boolean;
  status: StatusJson | null;
  transcript: TranscriptLine[];
  activity: ActivityLine[];
  // --- memory files (Slice 2) ---
  summary: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  participants: ParticipantsState;
  wakeEvents: WakeEventRecord[];
}

const STATUS = "status.json";
const TRANSCRIPT = "transcript.md";
const ACTIVITY = "activity.log";
const SUMMARY = "rolling-summary.md";
const DECISIONS = "decisions.md";
const ACTION_ITEMS = "action-items.md";
const OPEN_QUESTIONS = "open-questions.md";
const PARTICIPANTS = "participants.md";
const WAKE_LOG = "wake-log.jsonl";

// "- [HH:MM:SS] Speaker Name: spoken text"
const TRANSCRIPT_RE = /^- \[(\d{2}:\d{2}:\d{2})\]\s+([^:]+?):\s*(.*)$/;
// "HH:MM:SS <icon> text" (icon is whatever non-space glyph Dashboard.add wrote)
const ACTIVITY_RE = /^(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$/;
// "- [HH:MM:SS] item text" (the [ts] prefix is optional) — mirrors MeetingMemory.readList
const LIST_ITEM_RE = /^- (?:\[\d{2}:\d{2}:\d{2}\]\s*)?(.*)$/;

export function parseTranscript(content: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    const m = TRANSCRIPT_RE.exec(line);
    if (m) out.push({ ts: m[1]!, speaker: m[2]!.trim(), text: m[3]!.trim(), raw: line });
  }
  return out;
}

export function parseActivity(content: string): ActivityLine[] {
  const out: ActivityLine[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = ACTIVITY_RE.exec(line);
    if (m) out.push({ ts: m[1]!, icon: m[2]!, text: m[3]!.trim(), raw: line });
  }
  return out;
}

/** Bullet items from a memory list file (decisions/actions/questions), with the
 *  leading "- " and optional "[HH:MM:SS]" timestamp stripped. */
export function parseList(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const m = LIST_ITEM_RE.exec(line);
    if (m && m[1]!.trim()) out.push(m[1]!.trim());
  }
  return out;
}

/** Strip rolling-summary.md's "# …" header + "_…_" italic preamble (mirrors
 *  MeetingMemory.stripHeader) to the bare summary text. */
export function parseSummary(content: string): string {
  return content
    .replace(/^# .*\n/, "")
    .replace(/^_.*_\n/m, "")
    .trim();
}

/** Parse wake-log.jsonl (one JSON WakeEvent per line; tolerant of partials). */
export function parseWakeLog(content: string): WakeEventRecord[] {
  const out: WakeEventRecord[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line) as WakeEventRecord;
      if (o && typeof o.utterance === "string") out.push(o);
    } catch {
      /* skip a partial/garbled line */
    }
  }
  return out;
}

/** Parse participants.md (Participants.render) into present/left rosters. */
export function parseParticipants(content: string): ParticipantsState {
  const present: string[] = [];
  const left: string[] = [];
  let section: "present" | "left" | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (/^##\s+in the call/i.test(line)) {
      section = "present";
      continue;
    }
    if (/^##\s+left/i.test(line)) {
      section = "left";
      continue;
    }
    if (line.startsWith("- ")) {
      const name = line.slice(2).trim();
      if (!name || name === "(none yet)") continue;
      if (section === "present") present.push(name);
      else if (section === "left") left.push(name);
    }
  }
  return { present, left };
}

/**
 * Reads + tails the live-call files. `read()` is a pure snapshot; `watch()` polls
 * for changes (mtime-gated so an idle call costs almost nothing — the runtime
 * already debounces its writes) and fires the callback only when something moved.
 */
export class LiveStore {
  constructor(private readonly liveDir: string) {}

  private mtime(file: string): number {
    try {
      return statSync(join(this.liveDir, file)).mtimeMs;
    } catch {
      return 0;
    }
  }

  private safeRead(file: string): string {
    const path = join(this.liveDir, file);
    try {
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    } catch {
      return "";
    }
  }

  read(): LiveState {
    const statusRaw = this.safeRead(STATUS);
    let status: StatusJson | null = null;
    if (statusRaw.trim()) {
      try {
        status = JSON.parse(statusRaw) as StatusJson;
      } catch {
        status = null; // a half-written file; next poll picks up the complete one
      }
    }
    const transcript = parseTranscript(this.safeRead(TRANSCRIPT));
    const activity = parseActivity(this.safeRead(ACTIVITY));
    const liveExists =
      existsSync(join(this.liveDir, STATUS)) || existsSync(join(this.liveDir, TRANSCRIPT));
    return {
      liveExists,
      status,
      transcript,
      activity,
      summary: parseSummary(this.safeRead(SUMMARY)),
      decisions: parseList(this.safeRead(DECISIONS)),
      actionItems: parseList(this.safeRead(ACTION_ITEMS)),
      openQuestions: parseList(this.safeRead(OPEN_QUESTIONS)),
      participants: parseParticipants(this.safeRead(PARTICIPANTS)),
      wakeEvents: parseWakeLog(this.safeRead(WAKE_LOG)),
    };
  }

  /** A cheap fingerprint of the tailed files; changes when any is rewritten. */
  fingerprint(): string {
    return [STATUS, TRANSCRIPT, ACTIVITY, SUMMARY, DECISIONS, ACTION_ITEMS, OPEN_QUESTIONS, PARTICIPANTS, WAKE_LOG]
      .map((f) => this.mtime(f))
      .join(":");
  }

  /** Poll for changes; invoke `onChange` with a fresh snapshot on each change.
   *  Fires once immediately. Returns an unsubscribe. */
  watch(onChange: (state: LiveState) => void, intervalMs = 500): () => void {
    let last = "";
    const tick = () => {
      const fp = this.fingerprint();
      if (fp !== last) {
        last = fp;
        onChange(this.read());
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }
}
