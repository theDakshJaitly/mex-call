import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../control/ControlClient.js";
import { controlSocketPath } from "../control/protocol.js";
import { resolvePublicUrl } from "../recall/tunnel.js";

/**
 * Process model A (TUI as controller): the TUI spawns `mex-call join` (and ngrok
 * if needed) as CHILD processes and drives them over the control socket. It never
 * imports the loops/brain — if the TUI crashes, the call keeps running. This is
 * the same body/brain/memory separation that makes the npm path fast.
 */

export interface RuntimeOptions {
  meetUrl: string;
  repo: string;
  port: number;
  /** Extra args forwarded to `join` (e.g. --transport, --provider). */
  extraArgs?: string[];
}

export type ControllerEvent =
  | { type: "log"; line: string }
  | { type: "archived"; path: string }
  | { type: "timing"; totalMs: number }
  | { type: "error"; line: string }
  | { type: "exit"; code: number | null };

/** Locate the built (or source) cli entry to spawn `join` from. */
function resolveCliCommand(): { cmd: string; args: string[] } {
  // Prod: dist/tui/main.js → ../cli.js = dist/cli.js. Dev (tsx): src/tui/main.tsx
  // → ../cli.js doesn't exist, fall back to running cli.ts through tsx.
  const jsPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  if (existsSync(jsPath)) return { cmd: process.execPath, args: [jsPath] };
  const tsPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
  return { cmd: "npx", args: ["tsx", tsPath] };
}

/** "archived call → <path>" is logged by the runtime at finalize. */
const ARCHIVED_RE = /archived call → (.+)$/;
/** The runtime's per-reply latency breakdown ends with "total≈<n>ms" (--timings). */
const TIMING_RE = /total≈(\d+)ms/;
/** Curated error/instability patterns worth surfacing prominently (Slice 5),
 *  incl. the 1008/3006-style STT socket drops. */
const ERROR_RE =
  /failed to join|socket error|closed \((?:1008|3006|4\d\d\d|10\d\d|30\d\d)|event-log write failed|consent message failed|closing message failed|active invocation failed|compaction failed|did not come up|control socket unavailable|\bError:/i;

export class CallController {
  private child: ControlProcess | null = null;
  private client: ControlClient | null = null;

  constructor(private readonly onEvent: (ev: ControllerEvent) => void) {}

  /**
   * Ensure a public URL exists (auto-detect a running ngrok, else spawn one),
   * spawn `mex-call join`, and connect the control client (retrying until the
   * runtime's socket is up). Resolves once the client is connected.
   */
  async start(opts: RuntimeOptions): Promise<void> {
    await this.ensureTunnel(opts.port);

    const { cmd, args } = resolveCliCommand();
    const joinArgs = [
      ...args,
      "join",
      opts.meetUrl,
      "-r",
      opts.repo,
      "-p",
      String(opts.port),
      "--timings", // the TUI surfaces a latency HUD from these lines
      ...(opts.extraArgs ?? []),
    ];
    const child = spawn(cmd, joinArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = { proc: child };

    const onLine = (line: string) => {
      this.onEvent({ type: "log", line });
      const archived = ARCHIVED_RE.exec(line);
      if (archived) this.onEvent({ type: "archived", path: archived[1]!.trim() });
      const timing = TIMING_RE.exec(line);
      if (timing) this.onEvent({ type: "timing", totalMs: Number(timing[1]) });
      if (ERROR_RE.test(line)) this.onEvent({ type: "error", line: line.replace(/^\[mex-call\]\s*/, "") });
    };
    pipeLines(child, onLine);
    child.on("exit", (code) => this.onEvent({ type: "exit", code }));

    // The runtime derives its socket path from its own pid (== child.pid). Wait
    // for it to come up: join has to actually enter the call before listening.
    if (child.pid) await this.connectClient(controlSocketPath(child.pid));
  }

  private async ensureTunnel(port: number): Promise<void> {
    try {
      const { url, source } = await resolvePublicUrl(port);
      this.onEvent({ type: "log", line: `[tui] tunnel ready (${source}): ${url}` });
      return;
    } catch {
      // No tunnel yet — spawn ngrok and wait for it to register a public URL.
    }
    this.onEvent({ type: "log", line: `[tui] starting ngrok http ${port}…` });
    try {
      spawn("ngrok", ["http", String(port)], { stdio: "ignore", detached: false });
    } catch {
      throw new Error("ngrok is not installed or not on PATH — install it or set MEXCALL_PUBLIC_URL");
    }
    // Poll its local API until a tunnel appears (resolvePublicUrl reads it).
    const deadline = Date.now() + 20_000;
    for (;;) {
      await delay(500);
      try {
        const { url } = await resolvePublicUrl(port);
        this.onEvent({ type: "log", line: `[tui] ngrok ready: ${url}` });
        return;
      } catch {
        if (Date.now() > deadline) throw new Error("ngrok did not come up within 20s");
      }
    }
  }

  private async connectClient(socketPath: string): Promise<void> {
    const deadline = Date.now() + 60_000; // joining a call can take a while
    for (;;) {
      const client = new ControlClient(socketPath);
      try {
        await client.connect();
        this.client = client;
        this.onEvent({ type: "log", line: "[tui] control channel connected" });
        return;
      } catch {
        if (Date.now() > deadline) {
          this.onEvent({ type: "log", line: "[tui] control channel never came up (call still running)" });
          return; // non-fatal: file tailing still works; controls are just disabled
        }
        await delay(700);
      }
    }
  }

  // --- Control commands (delegate to the socket; no-op if not connected) -------

  async typeToMex(text: string): Promise<void> {
    await this.client?.send({ type: "inject-mex-command", text });
  }
  async sendChat(text: string): Promise<void> {
    await this.client?.send({ type: "send-chat", text });
  }
  async forceSummary(): Promise<void> {
    await this.client?.send({ type: "force-summary" });
  }
  async promote(text: string, kind: "decision" | "action" | "question"): Promise<void> {
    await this.client?.send({ type: "promote-item", text, kind });
  }
  async editItem(kind: "decision" | "action" | "question", index: number, text: string): Promise<void> {
    await this.client?.send({ type: "edit-item", kind, index, text });
  }
  async leave(): Promise<void> {
    await this.client?.send({ type: "leave" });
  }

  get connected(): boolean {
    return this.client != null;
  }

  /** Tear down the client; leave the child alone (use leave() for a graceful end). */
  dispose(): void {
    this.client?.close();
    this.client = null;
  }
}

interface ControlProcess {
  proc: ChildProcess;
}

/** Forward a child's stdout+stderr to a per-line callback. */
function pipeLines(child: ChildProcess, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
