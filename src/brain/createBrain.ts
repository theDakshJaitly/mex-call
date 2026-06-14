import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { Brain } from "./Brain.js";
import { ClaudeCodeBrain } from "./ClaudeCodeBrain.js";
import { CodexBrain } from "./CodexBrain.js";
import { ACTION_ALLOWED_TOOLS } from "../config.js";

export type Agent = "claude" | "codex";
export type BrainRole = "text" | "action";

/**
 * Decide which agent's headless CLI powers the brain. Order:
 *   1. explicit override (--brain / MEXCALL_BRAIN)
 *   2. environment markers — Claude Code sets CLAUDECODE; Codex sets CODEX_*
 *      (so when mex-call is launched from inside an agent, it uses that agent)
 *   3. whichever CLI is actually installed (claude preferred)
 *   4. claude as the default
 */
export function detectAgent(override?: string): Agent {
  const o = (override ?? process.env.MEXCALL_BRAIN ?? "").toLowerCase();
  if (o === "claude" || o === "codex") return o;
  if (process.env.CLAUDECODE) return "claude";
  if (Object.keys(process.env).some((k) => k.startsWith("CODEX"))) return "codex";
  if (hasBin("claude")) return "claude";
  if (hasBin("codex")) return "codex";
  return "claude";
}

function hasBin(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface CreateBrainOptions {
  /** "text" = compaction/classify (no writes); "action" = in-repo tool use. */
  role: BrainRole;
  /** Force an agent; otherwise auto-detected. */
  agent?: Agent;
  /** Claude model alias (sonnet/opus). Ignored under codex (uses MEXCALL_CODEX_MODEL). */
  claudeModel: string;
  timeoutMs: number;
  /** Working dir — the action brain runs in the repo. */
  cwd?: string;
}

/**
 * Build a Brain for the detected (or forced) agent, configured for its role.
 * Text role gets no tools / read-only; action role gets repo write tools. The
 * loops are agent-agnostic — they only see the Brain interface.
 */
export function createBrain(o: CreateBrainOptions): Brain {
  const agent = o.agent ?? detectAgent();
  if (agent === "codex") {
    return new CodexBrain({
      model: process.env.MEXCALL_CODEX_MODEL,
      timeoutMs: o.timeoutMs,
      cwd: o.cwd,
      sandbox: o.role === "action" ? "workspace-write" : "read-only",
    });
  }
  const isAction = o.role === "action";
  return new ClaudeCodeBrain({
    model: o.claudeModel,
    timeoutMs: o.timeoutMs,
    // The text role (passive compaction + active replies) is pure text→JSON with
    // no tools, so run it from a neutral cwd and with --strict-mcp-config: it then
    // never pays to auto-discover the target repo's CLAUDE.md or boot its MCP
    // servers on every call — a per-invocation latency tax the passive loop pays
    // on a timer. The action role keeps the repo cwd + repo MCP; it does real work.
    cwd: isAction ? o.cwd : o.cwd ?? tmpdir(),
    extraArgs: isAction
      ? ["--allowedTools", ...ACTION_ALLOWED_TOOLS]
      : ["--allowedTools", "", "--strict-mcp-config"],
  });
}
