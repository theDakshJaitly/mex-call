import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { MeetingMemory } from "../memory/MeetingMemory.js";
import type { Participants } from "../recall/Participants.js";

/**
 * Pre-renders a human-readable live dashboard (dashboard.md), a machine status
 * (status.json), and an append-only activity feed (activity.log) from data the
 * loops already computed. Pure formatting — NO model calls — so the /mex-call
 * session and `mex-call watch` can refresh it as often as they like for free.
 */

export interface DashboardMeta {
  callName: string;
  meetUrl: string;
  botName: string;
}

interface ActivityEvent {
  ts: number;
  icon: string;
  text: string;
}

const MAX_ACTIVITY = 40;

export class Dashboard {
  private status = "starting";
  private readonly startedAt = Date.now();
  private endedAt: number | null = null;
  private readonly activity: ActivityEvent[] = [];

  constructor(
    private readonly liveDir: string,
    private readonly meta: DashboardMeta,
    private readonly memory: MeetingMemory,
    private readonly participants: Participants
  ) {}

  setStatus(status: string): void {
    this.status = status;
  }

  markEnded(): void {
    this.endedAt = Date.now();
  }

  /** Record an event (icon + text), keep a bounded tail, append to activity.log. */
  add(icon: string, text: string): void {
    const ev = { ts: Date.now(), icon, text };
    this.activity.push(ev);
    if (this.activity.length > MAX_ACTIVITY) this.activity.shift();
    try {
      appendFileSync(join(this.liveDir, "activity.log"), `${clock(ev.ts)} ${icon} ${text}\n`);
    } catch {
      /* best-effort */
    }
  }

  /** Re-render dashboard.md + status.json. Call after any state change. */
  write(): void {
    try {
      writeFileSync(join(this.liveDir, "dashboard.md"), this.render());
      writeFileSync(join(this.liveDir, "status.json"), JSON.stringify(this.statusObject(), null, 2));
    } catch {
      /* best-effort; never let dashboard I/O break the call */
    }
  }

  private statusObject() {
    return {
      callName: this.meta.callName,
      meetUrl: this.meta.meetUrl,
      botName: this.meta.botName,
      status: this.status,
      ended: this.endedAt != null,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      elapsedMs: (this.endedAt ?? Date.now()) - this.startedAt,
      counts: {
        participants: this.participants.presentNames().length,
        decisions: this.memory.readDecisions().length,
        actionItems: this.memory.readActionItems().length,
        openQuestions: this.memory.readOpenQuestions().length,
      },
    };
  }

  private render(): string {
    const s = this.statusObject();
    const present = this.participants.presentNames();
    const decisions = this.memory.readDecisions();
    const actions = this.memory.readActionItems();
    const questions = this.memory.readOpenQuestions();
    const summary = this.memory.readSummary().trim();

    const lines: string[] = [];
    lines.push(`# 🎙  mex-call · ${this.meta.callName}`);
    lines.push("");
    lines.push(`**${statusBadge(this.status, s.ended)}**  ·  elapsed ${duration(s.elapsedMs)}  ·  updated ${clock(s.updatedAt)}`);
    lines.push(`**Meet:** ${this.meta.meetUrl}`);
    lines.push(`**Bot:** ${this.meta.botName}`);
    lines.push("");
    lines.push(`## In the room (${present.length})`);
    lines.push(present.length ? present.map((n) => `- ${n}`).join("\n") : "_(waiting for participants)_");
    lines.push("");
    lines.push(`## Memory   ·   ${decisions.length} decisions · ${actions.length} action items · ${questions.length} open questions`);
    lines.push("");
    lines.push("### Rolling summary");
    lines.push(summary || "_(building…)_");
    if (decisions.length) {
      lines.push("");
      lines.push("### Decisions");
      lines.push(latest(decisions, 5));
    }
    if (actions.length) {
      lines.push("");
      lines.push("### Action items");
      lines.push(latest(actions, 5));
    }
    if (questions.length) {
      lines.push("");
      lines.push("### Open questions");
      lines.push(latest(questions, 5));
    }
    lines.push("");
    lines.push("## Activity");
    lines.push(
      this.activity.length
        ? this.activity
            .slice(-15)
            .map((e) => `- \`${clock(e.ts)}\`  ${e.icon} ${e.text}`)
            .join("\n")
        : "_(nothing yet)_"
    );
    lines.push("");
    return lines.join("\n") + "\n";
  }
}

function latest(items: string[], n: number): string {
  const tail = items.slice(-n);
  const more = items.length - tail.length;
  const body = tail.map((i) => `- ${i}`).join("\n");
  return more > 0 ? `_…${more} earlier_\n${body}` : body;
}

function statusBadge(status: string, ended: boolean): string {
  if (ended) return "⚪ ended";
  if (status === "in_call_recording") return "🟢 recording";
  if (status.startsWith("in_call")) return "🟢 in call";
  if (status === "in_waiting_room") return "🟡 waiting room";
  if (status === "joining_call") return "🟡 joining";
  return `⚪ ${status}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad(m)}:${pad(s)}`;
}
