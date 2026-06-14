import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createConfig, readEvents, type EventEntry } from "mex-agent";
import type { MexScaffoldStatus } from "../memory/scaffold.js";

/**
 * When a real mex scaffold is present, read a BOUNDED slice of its authored
 * context + patterns so the active loop can answer "what does the repo say
 * about this?". Read-only (rule 3) and capped so we never blow the model budget.
 *
 * Returns "" when there's no scaffold — the active loop simply runs without it.
 */
export function readMexContext(repoRoot: string, status: MexScaffoldStatus, maxChars = 6_000): string {
  if (!status.present) return "";
  const dirs = [join(status.mexDir, "context"), join(status.mexDir, "patterns")];
  const parts: string[] = [];
  let total = 0;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, f);
      try {
        if (!statSync(p).isFile()) continue;
        const body = readFileSync(p, "utf8").trim();
        if (!body) continue;
        const header = `--- ${f} ---\n`;
        const remaining = maxChars - total;
        if (header.length + body.length + 2 > remaining) {
          const slice = body.slice(0, Math.max(0, remaining - header.length));
          if (slice) parts.push(header + slice);
          return parts.join("\n").trim();
        }
        parts.push(header + body);
        total += header.length + body.length + 2;
      } catch {
        /* skip unreadable file */
      }
    }
  }

  return parts.join("\n").trim();
}

/**
 * When a real mex scaffold is present, read a BOUNDED, recent slice of its EVENT
 * LOG so the active loop can answer cross-call memory questions — "what did we
 * decide about X?", "did we already agree on Y?" — from this repo's actual
 * decision history, not just the current call. This is the gap the closing
 * "with mex you'd get repo-wide history" nudge used to only promise.
 *
 * Read via the IN-PROCESS mex-agent API (NOT `mex timeline`, which pays a Node
 * cold-start + ~800ms telemetry network-flush per call — see memory/events.ts).
 * Newest first, filtered to the kinds worth recalling and capped so it never
 * blows the model budget. Returns "" with no scaffold or on any read error.
 */
export function readMexEventHistory(
  repoRoot: string,
  status: MexScaffoldStatus,
  { maxEntries = 20, maxChars = 2_500 }: { maxEntries?: number; maxChars?: number } = {}
): string {
  if (!status.present) return "";

  let events: EventEntry[];
  try {
    const config = createConfig({ projectRoot: repoRoot, scaffoldRoot: status.mexDir });
    events = readEvents(config);
  } catch {
    return ""; // malformed/absent log — run without history rather than fail the reply
  }
  if (!events.length) return "";

  // Decisions, todos and risks are the cross-call history worth recalling; plain
  // notes are noisier, so we drop them to protect the budget. ISO timestamps sort
  // lexicographically, so a string compare gives newest-first.
  const KINDS = new Set(["decision", "todo", "risk"]);
  const recent = events
    .filter((e) => KINDS.has(e.kind) && e.message.trim())
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, maxEntries);
  if (!recent.length) return "";

  const lines: string[] = [];
  let total = 0;
  for (const e of recent) {
    const day = e.timestamp.slice(0, 10); // YYYY-MM-DD
    const status_ = e.status ? `, ${e.status}` : "";
    const line = `- [${e.kind}${status_}, ${day}] ${e.message.trim()}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n").trim();
}
