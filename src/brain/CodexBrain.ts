import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Brain, BrainRunOptions } from "./Brain.js";

export interface CodexBrainOptions {
  /** Codex model (e.g. from MEXCALL_CODEX_MODEL). Unset → codex's default. */
  model?: string;
  bin?: string;
  timeoutMs?: number;
  /**
   * Sandbox for model-generated shell commands. "read-only" for the text brain
   * (compaction/classify — no writes); "workspace-write" for the action brain.
   */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Working root for the agent. The action brain runs in the repo. */
  cwd?: string;
}

/**
 * Brain backed by headless Codex (`codex exec`). The agent's final message is
 * written cleanly to a temp file via `-o`, so we don't have to scrape stdout.
 * Behind the same Brain interface as ClaudeCodeBrain — the loops don't care
 * which agent powers the brain (see createBrain.ts for auto-detection).
 */
export class CodexBrain implements Brain {
  private readonly model: string | undefined;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly sandbox: NonNullable<CodexBrainOptions["sandbox"]>;
  private readonly cwd: string | undefined;

  constructor(opts: CodexBrainOptions = {}) {
    this.model = opts.model;
    this.bin = opts.bin ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.sandbox = opts.sandbox ?? "read-only";
    this.cwd = opts.cwd;
  }

  async run(prompt: string, opts: BrainRunOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const outFile = join(tmpdir(), `mexcall-codex-${randomBytes(8).toString("hex")}.txt`);

    const args = ["exec", "--skip-git-repo-check", "--color", "never", "--sandbox", this.sandbox, "-o", outFile];
    if (this.cwd) args.push("-C", this.cwd);
    // Per-call model is a Claude alias (sonnet/opus) — irrelevant to codex; use
    // the configured codex model only.
    if (this.model) args.push("-m", this.model);
    args.push("-"); // read the prompt from stdin

    try {
      await this.exec(args, prompt, timeoutMs);
      return readFileSync(outFile, "utf8").trim();
    } finally {
      try {
        rmSync(outFile, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  private exec(args: string[], stdin: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"], cwd: this.cwd });
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`codex invocation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

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
          reject(new Error(`codex exited with code ${code}: ${stderr.trim().slice(0, 400) || "(no stderr)"}`));
          return;
        }
        resolve();
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}
