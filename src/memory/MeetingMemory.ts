import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptChunk } from "../types.js";

/**
 * The file-I/O layer — the "boring and reliable" bridge between the runtime and
 * Claude Code (rule 6). Everything lives under <repoRoot>/.mex/meetings/live/.
 *
 * Bounded by construction (rule 5):
 *   - transcript.md is the only unbounded, append-only file. It is the full
 *     record and is NEVER sent to the model.
 *   - current-window.md holds only transcript NOT YET folded into the rolling
 *     summary. The passive loop sheds it (shedWindow) only after a successful
 *     compaction, so content is never dropped before it's captured — and a
 *     size trigger in the loop compacts before the buffer can grow large.
 *   - This window plus rolling-summary.md is all the model ever sees.
 */

const LIVE_FILES = {
  transcript: "transcript.md",
  window: "current-window.md",
  summary: "rolling-summary.md",
  participants: "participants.md",
  decisions: "decisions.md",
  actionItems: "action-items.md",
  openQuestions: "open-questions.md",
} as const;

const FILE_HEADERS: Record<string, string> = {
  [LIVE_FILES.transcript]: "# Transcript (full, append-only — never sent to the model)\n\n",
  [LIVE_FILES.window]: "# Current window (transcript not yet folded into the rolling summary)\n\n",
  [LIVE_FILES.summary]: "# Rolling summary\n\n_Compacted continuously; stays bounded regardless of meeting length._\n\n",
  [LIVE_FILES.participants]: "# Participants\n\n",
  [LIVE_FILES.decisions]: "# Decisions\n\n",
  [LIVE_FILES.actionItems]: "# Action items\n\n",
  [LIVE_FILES.openQuestions]: "# Open questions\n\n",
};

export class MeetingMemory {
  readonly meetingsDir: string;
  readonly liveDir: string;
  /** Unsummarized transcript lines — folded into the summary then shed by the loop. */
  private windowLines: string[] = [];

  constructor(repoRoot: string) {
    this.meetingsDir = join(repoRoot, ".mex", "meetings");
    this.liveDir = join(this.meetingsDir, "live");
  }

  /** Create the live/ folder and seed each file with its header. Idempotent. */
  init(): void {
    mkdirSync(this.liveDir, { recursive: true });
    for (const file of Object.values(LIVE_FILES)) {
      const path = join(this.liveDir, file);
      if (!existsSync(path)) writeFileSync(path, FILE_HEADERS[file] ?? "");
    }
  }

  private path(file: string): string {
    return join(this.liveDir, file);
  }

  // --- Transcript + window ----------------------------------------------------

  /** Record a finalized chunk: append to the full transcript, accumulate in the window. */
  ingest(chunk: TranscriptChunk): void {
    const line = formatLine(chunk);
    appendFileSync(this.path(LIVE_FILES.transcript), line + "\n");
    this.windowLines.push(line);
    this.flushWindow();
  }

  private flushWindow(): void {
    const body = this.windowLines.length ? this.windowLines.join("\n") + "\n" : "";
    writeFileSync(this.path(LIVE_FILES.window), FILE_HEADERS[LIVE_FILES.window] + body);
  }

  readWindow(): string {
    return this.windowLines.join("\n");
  }

  /** Current unsummarized size — the loop uses this as a compaction trigger. */
  windowChars(): number {
    return this.windowLines.join("\n").length;
  }

  /** Snapshot the window to compact. `count` is what the loop sheds on success. */
  snapshotWindow(): { text: string; count: number } {
    return { text: this.windowLines.join("\n"), count: this.windowLines.length };
  }

  /**
   * Drop the first `count` lines (now folded into the rolling summary), keeping
   * any that arrived while compaction was running. Called ONLY after a summary
   * that captured them was written — so nothing is lost.
   */
  shedWindow(count: number): void {
    if (count <= 0) return;
    this.windowLines = this.windowLines.slice(count);
    this.flushWindow();
  }

  // --- Rolling summary --------------------------------------------------------

  readSummary(): string {
    return stripHeader(this.safeRead(LIVE_FILES.summary));
  }

  writeSummary(text: string): void {
    writeFileSync(this.path(LIVE_FILES.summary), FILE_HEADERS[LIVE_FILES.summary] + text.trim() + "\n");
  }

  // --- Lists (decisions / action items / open questions) ----------------------

  readDecisions(): string[] {
    return this.readList(LIVE_FILES.decisions);
  }
  readActionItems(): string[] {
    return this.readList(LIVE_FILES.actionItems);
  }
  readOpenQuestions(): string[] {
    return this.readList(LIVE_FILES.openQuestions);
  }

  appendDecisions(items: string[]): void {
    this.appendList(LIVE_FILES.decisions, items);
  }
  appendActionItems(items: string[]): void {
    this.appendList(LIVE_FILES.actionItems, items);
  }
  appendOpenQuestions(items: string[]): void {
    this.appendList(LIVE_FILES.openQuestions, items);
  }

  /** Parse the existing bullet texts (timestamp prefix stripped) for dedup. */
  private readList(file: string): string[] {
    const body = this.safeRead(file);
    return body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "").trim())
      .filter(Boolean);
  }

  private appendList(file: string, items: string[]): void {
    if (!items.length) return;
    const ts = clockNow();
    const lines = items.map((i) => `- [${ts}] ${i.trim()}`).join("\n");
    appendFileSync(this.path(file), lines + "\n");
  }

  /**
   * Edit or remove the `index`-th item (in file order, matching readList) of a
   * captured list. Empty `text` removes the line; otherwise the bullet's
   * [HH:MM:SS] timestamp is preserved and only the text is replaced. The manual
   * safety net behind the TUI's edit/promote (Slice 4). No-op if out of range.
   */
  editListItem(kind: "decision" | "action" | "question", index: number, text: string): void {
    const file =
      kind === "decision" ? LIVE_FILES.decisions : kind === "action" ? LIVE_FILES.actionItems : LIVE_FILES.openQuestions;
    const content = this.safeRead(file);
    if (!content) return;
    const lines = content.split("\n");
    const bulletIdxs = lines.map((l, i) => (l.trim().startsWith("- ") ? i : -1)).filter((i) => i >= 0);
    const target = bulletIdxs[index];
    if (target == null) return;
    if (!text.trim()) {
      lines.splice(target, 1);
    } else {
      const prefix = /^(\s*- \[\d{2}:\d{2}:\d{2}\]\s*)/.exec(lines[target]!);
      lines[target] = (prefix ? prefix[1] : "- ") + text.trim();
    }
    writeFileSync(this.path(file), lines.join("\n"));
  }

  // --- Participants (stub for MVP 0; populated from Recall events in MVP 1) ----

  writeParticipants(text: string): void {
    writeFileSync(this.path(LIVE_FILES.participants), FILE_HEADERS[LIVE_FILES.participants] + text.trim() + "\n");
  }

  // --- Archiving --------------------------------------------------------------

  /**
   * Move live/ to <meetingsDir>/<archiveName>/ and start a fresh live/.
   * Returns the archive path.
   */
  archiveLive(archiveName: string): string {
    let target = join(this.meetingsDir, archiveName);
    let n = 2;
    while (existsSync(target)) target = join(this.meetingsDir, `${archiveName}-${n++}`);
    renameSync(this.liveDir, target);
    this.windowLines = [];
    this.init();
    return target;
  }

  writeFinalSummary(archivePath: string, markdown: string): void {
    writeFileSync(join(archivePath, "final-summary.md"), markdown.trim() + "\n");
  }

  // --- helpers ----------------------------------------------------------------

  private safeRead(file: string): string {
    const path = this.path(file);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }
}

function formatLine(chunk: TranscriptChunk): string {
  const ts = clockFromMs(chunk.timestampMs);
  return `- [${ts}] ${chunk.speaker}: ${chunk.text.trim()}`;
}

function stripHeader(content: string): string {
  // Drop leading "# ..." header lines + blank/italic preamble.
  return content
    .replace(/^# .*\n/, "")
    .replace(/^_.*_\n/m, "")
    .trim();
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function clockFromMs(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clockNow(): string {
  return clockFromMs(Date.now());
}
