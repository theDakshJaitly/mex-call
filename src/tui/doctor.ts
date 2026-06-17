import { execSync } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, relative, join } from "node:path";
import WebSocket from "ws";
import { createConfig, readEvents, type EventEntry } from "mex-agent";
import { loadEnv } from "../util/env.js";
import { resolveStt, ASSEMBLY_KEYTERMS, type SttResolution } from "../config.js";
import { detectMexScaffold, type MexScaffoldStatus } from "../memory/scaffold.js";
import { buildStreamingUrl } from "../stt/AssemblyAiStreamingClient.js";

/**
 * Pre-flight ("Doctor") logic. Pure Node (no React) so it's testable and so the
 * STT resolution mirrors the runtime EXACTLY (TUI_EXECUTION_PLAN §4): the Doctor
 * must reflect `resolveStt`, never reimplement it, and the weak-built-in-STT case
 * is a HARD warning that prevents a silent green-light.
 */

export type CheckLevel = "pass" | "warn" | "fail";
export interface Check {
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface DoctorReport {
  checks: Check[];
  /** Hard requirements met (a transport key + an installed brain CLI). */
  greenLight: boolean;
  /** The run would use Recall's weak built-in STT — surface a prominent warning. */
  sttWeak: boolean;
  hasAssemblyKey: boolean;
  stt: SttResolution | null; // null for vexa (recall-only resolution)
  brain: "claude" | "codex" | null;
  mex: MexScaffoldStatus;
  transport: "recall" | "vexa";
}

export interface DoctorOptions {
  transport?: "recall" | "vexa";
  /** Explicit --provider, mirrored into resolveStt. */
  provider?: string;
}

function hasBin(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Load env the same way `join` does, so the Doctor sees the same keys. */
export function loadCallEnv(repo: string): void {
  loadEnv(resolve(repo, ".env"));
  loadEnv(resolve(process.cwd(), ".env"));
  loadEnv(resolve(homedir(), ".mex-call.env"));
}

export function gatherDoctorReport(repo: string, opts: DoctorOptions = {}): DoctorReport {
  loadCallEnv(repo);
  const transport = opts.transport ?? "recall";
  const hasRecall = Boolean(process.env.RECALL_API_KEY);
  const hasVexa = Boolean(process.env.VEXA_API_KEY);
  const hasAssemblyKey = Boolean(process.env.ASSEMBLYAI_API_KEY);
  const stt = transport === "recall" ? resolveStt(opts.provider, hasAssemblyKey) : null;
  const sttWeak = transport === "recall" && stt != null && !stt.nativeStt && stt.recallProvider === "recallai_streaming";

  const brain: "claude" | "codex" | null = hasBin("claude") ? "claude" : hasBin("codex") ? "codex" : null;
  const ngrokInstalled = hasBin("ngrok");
  const mex = detectMexScaffold(repo);

  const checks: Check[] = [];

  // Transport key (the hard gate).
  if (transport === "recall") {
    checks.push({
      label: "RECALL_API_KEY",
      level: hasRecall ? "pass" : "fail",
      detail: hasRecall ? "set" : "missing — add to repo .env or ~/.mex-call.env",
    });
  } else {
    checks.push({
      label: "VEXA_API_KEY",
      level: hasVexa ? "pass" : "fail",
      detail: hasVexa ? "set" : "missing — add to repo .env or ~/.mex-call.env",
    });
  }

  // STT resolution — mirrors resolveStt, the actual runtime logic.
  checks.push({ label: "ASSEMBLYAI_API_KEY", level: hasAssemblyKey ? "pass" : "warn", detail: hasAssemblyKey ? "set" : "not set" });
  if (transport === "recall" && stt) {
    const provider = stt.nativeStt
      ? "native AssemblyAI (best wake accuracy)"
      : stt.recallProvider === "assembly_ai_v3_streaming"
        ? "AssemblyAI v3 via Recall"
        : "Recall built-in (recallai_streaming)";
    checks.push({
      label: "STT for this run",
      level: sttWeak ? "warn" : "pass",
      detail: sttWeak
        ? `${provider} — wake-word (“Mex”) detection will be UNRELIABLE. Set ASSEMBLYAI_API_KEY and it auto-switches.`
        : provider,
    });
  }

  // Brain CLI.
  checks.push({
    label: "Brain (coding-agent CLI)",
    level: brain ? "pass" : "fail",
    detail: brain ? `${brain} detected` : "neither `claude` nor `codex` on PATH — memory/replies can't run",
  });

  // ngrok (recall only; vexa needs no local webhook).
  if (transport === "recall") {
    checks.push({
      label: "ngrok",
      level: ngrokInstalled ? "pass" : "warn",
      detail: ngrokInstalled
        ? "installed — a tunnel is auto-detected/spawned at launch (auth verified then)"
        : "not on PATH — install it or set MEXCALL_PUBLIC_URL",
    });
  }

  // mex scaffold (enhancer, never required).
  checks.push({
    label: "mex scaffold",
    level: mex.present ? "pass" : "warn",
    detail: mex.present ? `present (${mex.reason}) — decisions log to your timeline` : "absent — runs standalone (mex-call setup wires the funnel)",
  });

  const transportKeyOk = transport === "recall" ? hasRecall : hasVexa;
  const greenLight = transportKeyOk && brain != null;

  return { checks, greenLight, sttWeak, hasAssemblyKey, stt, brain, mex, transport };
}

/**
 * Pre-join STT connectivity smoke test (§6): open the AssemblyAI v3 streaming
 * socket with the configured key and confirm it authenticates. This catches the
 * most common silent STT failure — a missing/expired key — BEFORE the meeting.
 *
 * NOTE: the full "say 'Mex, test'" mic-loopback is intentionally deferred — it
 * needs a local mic-capture subsystem (sox/ffmpeg) the codebase doesn't have yet
 * (the runtime gets audio from Recall's bot, not a local mic). This connectivity
 * check is the achievable, high-value core: a bad key is the failure that bites.
 */
export function smokeTestAssemblyAi(
  apiKey: string,
  keyterms: string[] = ASSEMBLY_KEYTERMS,
  timeoutMs = 8_000
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((res) => {
    let settled = false;
    const ws = new WebSocket(buildStreamingUrl({ apiKey, keyterms }), { headers: { Authorization: apiKey } });
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      res({ ok, detail });
    };
    const timer = setTimeout(() => done(false, "timed out connecting to AssemblyAI"), timeoutMs);
    ws.on("open", () => done(true, "connected + authenticated — wake path is reachable"));
    ws.on("unexpected-response", (_req, response) => done(false, `auth rejected (HTTP ${response.statusCode})`));
    ws.on("error", (err: Error) => done(false, err.message));
    ws.on("close", (code: number, reason: Buffer) =>
      done(false, `closed${code ? ` (${code})` : ""}${reason?.length ? `: ${reason.toString()}` : ""}`)
    );
  });
}

/**
 * Read the events THIS call logged to mex's timeline, via mex-agent's public
 * reader (§7 — never hand-parse the JSONL). Filters to source:"meeting" + this
 * call's trace; falls back to recent meeting events if the trace doesn't match.
 */
export function readMeetingEventsForCall(repo: string, scaffoldRoot: string, archivePath: string): EventEntry[] {
  try {
    const config = createConfig({ projectRoot: resolve(repo), scaffoldRoot: resolve(scaffoldRoot) });
    const all = readEvents(config);
    const trace = relative(resolve(repo), resolve(archivePath));
    const mine = all.filter((e) => e.source === "meeting" && e.trace === trace);
    return mine.length ? mine : all.filter((e) => e.source === "meeting").slice(-20);
  } catch {
    return [];
  }
}

/**
 * Read-only decision-vs-scaffold diff (§6, mex users only). A *preview* of
 * contradiction detection: for each captured decision, flag a scaffold doc that
 * talks about the same thing ("this call decided X; the scaffold has a stance in
 * Y"). Heuristic keyword overlap only — NEVER writes the scaffold, and real
 * contradiction detection is explicitly a later task (§11).
 */
export interface ScaffoldFlag {
  decision: string;
  file: string;
  line: string;
}

const STOPWORDS = new Set([
  "about", "after", "again", "their", "there", "these", "those", "which", "while", "would", "could",
  "should", "using", "into", "from", "with", "that", "this", "will", "shall", "have", "been", "were",
  "they", "them", "then", "than", "when", "what", "your", "yours", "also", "more", "most", "some",
  "such", "only", "very", "just", "like", "make", "made", "need", "want", "going", "gonna",
]);

function significantTerms(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 4 && !STOPWORDS.has(w))
  );
}

function listScaffoldDocs(scaffoldRoot: string): { rel: string; lines: string[] }[] {
  const out: { rel: string; lines: string[] }[] = [];
  try {
    for (const e of readdirSync(scaffoldRoot, { recursive: true }) as string[]) {
      const rel = String(e);
      if (!rel.endsWith(".md") || rel.startsWith("meetings")) continue; // skip our own output
      const full = join(scaffoldRoot, rel);
      try {
        if (statSync(full).isFile()) out.push({ rel, lines: readFileSync(full, "utf8").split("\n") });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no scaffold docs */
  }
  return out;
}

export function scaffoldDiff(scaffoldRoot: string, decisions: string[]): ScaffoldFlag[] {
  const docs = listScaffoldDocs(scaffoldRoot);
  if (!docs.length) return [];
  const flags: ScaffoldFlag[] = [];
  for (const decision of decisions) {
    const dt = significantTerms(decision);
    if (dt.size < 2) continue;
    let best: { rel: string; line: string; score: number } | null = null;
    for (const doc of docs) {
      for (const line of doc.lines) {
        const lt = significantTerms(line);
        let score = 0;
        for (const w of dt) if (lt.has(w)) score++;
        if (score >= 2 && (!best || score > best.score)) best = { rel: doc.rel, line: line.trim(), score };
      }
    }
    if (best) flags.push({ decision, file: best.rel, line: best.line.slice(0, 100) });
  }
  return flags;
}

/** List archived call folders under .mex/meetings (newest first) for Recent calls. */
export function listArchivedCalls(repo: string): { name: string; path: string }[] {
  const meetingsDir = join(resolve(repo), ".mex", "meetings");
  try {
    return readdirSync(meetingsDir)
      .filter((n) => n !== "live")
      .map((n) => ({ name: n, path: join(meetingsDir, n) }))
      .filter((e) => {
        try {
          return statSync(e.path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}
