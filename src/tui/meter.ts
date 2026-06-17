import type { LiveState } from "./store.js";

/**
 * Rough live cost/usage estimate (Slice 5). Deliberately approximate and labelled
 * "~est" in the UI — the point is a live sense of spend, not an invoice. Each
 * headless `claude -p` invocation pays a known ~$0.04 system-prompt overhead even
 * with no tools (see CLAUDE.md); AssemblyAI streaming is billed by the minute.
 */
export const CLAUDE_CALL_USD = 0.04;
/** ~$0.15/hr AssemblyAI Universal-Streaming → per-minute. */
export const ASSEMBLY_PER_MIN_USD = 0.15 / 60;

export interface UsageEstimate {
  brainCalls: number;
  brainUsd: number;
  sttMinutes: number;
  sttUsd: number;
  totalUsd: number;
}

export interface UsageInput {
  /** Passive-loop compactions (🧠) — one brain call each. */
  compactions: number;
  /** Wake considerations — each runs the classifier (one brain call). */
  wakeCount: number;
  /** Wakes routed to repo_action — an extra action-brain call each. */
  repoActions: number;
  elapsedMs: number;
  /** True when an AssemblyAI STT path is in use (native or Recall-managed). */
  usingAssembly: boolean;
}

export function estimateUsage(input: UsageInput): UsageEstimate {
  const brainCalls = input.compactions + input.wakeCount + input.repoActions;
  const brainUsd = brainCalls * CLAUDE_CALL_USD;
  const sttMinutes = input.usingAssembly ? Math.max(0, input.elapsedMs) / 60_000 : 0;
  const sttUsd = sttMinutes * ASSEMBLY_PER_MIN_USD;
  return { brainCalls, brainUsd, sttMinutes, sttUsd, totalUsd: brainUsd + sttUsd };
}

/** Derive the usage inputs straight from a live snapshot. */
export function usageFromState(view: LiveState, usingAssembly: boolean): UsageEstimate {
  return estimateUsage({
    compactions: view.activity.filter((a) => a.icon === "🧠").length,
    wakeCount: view.wakeEvents.length,
    repoActions: view.wakeEvents.filter((w) => w.action === "repo_action").length,
    elapsedMs: view.status?.elapsedMs ?? 0,
    usingAssembly,
  });
}

/**
 * Clean markdown export of a call's captured memory (Slice 5 copy-as-markdown).
 * Works on any LiveState — a live snapshot or one read from an archive folder.
 */
export function buildMarkdownReport(view: LiveState, title = "mex-call"): string {
  const lines: string[] = [];
  lines.push(`# ${title}${view.status?.callName ? ` · ${view.status.callName}` : ""}`);
  lines.push("");
  if (view.summary) {
    lines.push("## Summary");
    lines.push(view.summary);
    lines.push("");
  }
  const section = (heading: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`## ${heading}`);
    for (const it of items) lines.push(`- ${it}`);
    lines.push("");
  };
  section("Decisions", view.decisions);
  section("Action items", view.actionItems);
  section("Open questions", view.openQuestions);
  if (view.participants.present.length || view.participants.left.length) {
    lines.push("## Participants");
    if (view.participants.present.length) lines.push(`- present: ${view.participants.present.join(", ")}`);
    if (view.participants.left.length) lines.push(`- left: ${view.participants.left.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Compact "$0.32" formatting for the live meter. */
export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
