import type { ParticipantEvent } from "../types.js";

/**
 * Tracks who is/was in the call from transport ParticipantEvents and renders
 * participants.md. Transport-neutral (consumes only ParticipantEvent), so it
 * lives in transport/ rather than under any one vendor's adapter. Kept separate
 * from the transcript so the active loop can read a clean roster.
 */
export class Participants {
  private readonly present = new Map<string, { joinedAt: number }>();
  private readonly seen = new Set<string>();

  apply(ev: ParticipantEvent): void {
    if (ev.type === "join") {
      this.seen.add(ev.name);
      if (!this.present.has(ev.name)) this.present.set(ev.name, { joinedAt: ev.timestampMs });
    } else if (ev.type === "leave") {
      this.present.delete(ev.name);
    } else {
      this.seen.add(ev.name);
    }
  }

  /** True if this event changed the roster (worth re-rendering the file). */
  applyAndChanged(ev: ParticipantEvent): boolean {
    const before = `${[...this.present.keys()].sort().join("|")}::${[...this.seen].sort().join("|")}`;
    this.apply(ev);
    const after = `${[...this.present.keys()].sort().join("|")}::${[...this.seen].sort().join("|")}`;
    return before !== after;
  }

  /** Names currently in the call, sorted. */
  presentNames(): string[] {
    return [...this.present.keys()].sort();
  }

  render(): string {
    const here = [...this.present.keys()].sort();
    const left = [...this.seen].filter((n) => !this.present.has(n)).sort();
    const lines: string[] = [];
    lines.push("## In the call");
    lines.push(here.length ? here.map((n) => `- ${n}`).join("\n") : "- (none yet)");
    if (left.length) {
      lines.push("");
      lines.push("## Left");
      lines.push(left.map((n) => `- ${n}`).join("\n"));
    }
    return lines.join("\n");
  }
}
