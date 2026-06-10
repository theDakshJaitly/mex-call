import { spawn } from "node:child_process";
import type { Brain, BrainRunOptions } from "./Brain.js";

export interface ClaudeCodeBrainOptions {
  /** Default model alias when a call doesn't specify one. */
  model?: string;
  /** Path/name of the claude binary. */
  bin?: string;
  /** Default timeout for invocations. */
  timeoutMs?: number;
  /**
   * Extra CLI args. The passive loop needs no tools (pure text → JSON), so we
   * default to giving it none — cheaper, faster, and it can't touch files.
   * The MVP 4 action brain overrides this with an allow-list of repo tools.
   */
  extraArgs?: string[];
  /** Working directory for the invocation. The action brain runs in the repo. */
  cwd?: string;
}

/**
 * Brain backed by headless Claude Code (`claude -p`). Uses the user's existing
 * Claude Code auth — no ANTHROPIC_API_KEY required. The prompt is passed on
 * stdin (avoids argv length limits); output is parsed from `--output-format
 * json` so we get a clean `.result` string regardless of any preamble.
 */
export class ClaudeCodeBrain implements Brain {
  private readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly cwd: string | undefined;

  constructor(opts: ClaudeCodeBrainOptions = {}) {
    this.model = opts.model ?? "sonnet";
    this.bin = opts.bin ?? "claude";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.extraArgs = opts.extraArgs ?? ["--allowedTools", ""];
    this.cwd = opts.cwd;
  }

  async run(prompt: string, opts: BrainRunOptions = {}): Promise<string> {
    const model = opts.model ?? this.model;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    const args = ["-p", "--output-format", "json", "--model", model, ...this.extraArgs];
    if (opts.appendSystemPrompt) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    }

    const raw = await this.exec(args, prompt, timeoutMs);

    // `--output-format json` wraps the answer: { type, subtype, result, ... }.
    try {
      const parsed = JSON.parse(raw) as { result?: string; is_error?: boolean; subtype?: string };
      if (parsed.is_error) {
        throw new Error(`claude returned error (subtype=${parsed.subtype ?? "unknown"})`);
      }
      return (parsed.result ?? "").trim();
    } catch (err) {
      // Defensive: if the wrapper wasn't JSON for some reason, return raw text.
      if (raw.trim().startsWith("{")) throw err;
      return raw.trim();
    }
  }

  private exec(args: string[], stdin: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"], cwd: this.cwd });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`claude invocation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to spawn '${this.bin}': ${err.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude exited with code ${code}: ${stderr.trim() || "(no stderr)"}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}
