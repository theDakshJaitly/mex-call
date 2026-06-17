/**
 * Unit tests for the Doctor pre-flight logic (Slice 3). Asserts only the
 * deterministic, environment-independent behaviour — scaffold detection, the
 * archive listing, and the report's structure — NOT specific key presence (that
 * depends on the developer's real env / ~/.mex-call.env).
 *
 * Run:  npx tsx src/tui/doctor.test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherDoctorReport, listArchivedCalls, readMeetingEventsForCall, scaffoldDiff } from "./doctor.js";
import { loadTuiDefaults, saveTuiDefaults, DEFAULT_TUI_DEFAULTS } from "./config.js";

let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   — ${name}`);
  else {
    failures++;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function main(): void {
  // --- report structure + mex scaffold detection ------------------------------
  {
    const repo = mkdtempSync(join(tmpdir(), "mex-doctor-"));
    try {
      const report = gatherDoctorReport(repo);
      const labels = report.checks.map((c) => c.label);
      ok("report includes the transport-key check", labels.includes("RECALL_API_KEY"));
      ok("report includes the brain check", labels.some((l) => l.startsWith("Brain")));
      ok("report includes the mex-scaffold check", labels.includes("mex scaffold"));
      ok("greenLight is a boolean", typeof report.greenLight === "boolean");
      ok("no scaffold → mex.present false", report.mex.present === false);

      // Now plant a scaffold marker and re-check.
      mkdirSync(join(repo, ".mex"), { recursive: true });
      writeFileSync(join(repo, ".mex", "config.json"), "{}");
      const report2 = gatherDoctorReport(repo);
      ok("scaffold marker → mex.present true", report2.mex.present === true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // --- STT resolution mirrored from resolveStt --------------------------------
  {
    const repo = mkdtempSync(join(tmpdir(), "mex-doctor-stt-"));
    try {
      // Explicit recallai_streaming is the weak path → sttWeak must be true.
      const weak = gatherDoctorReport(repo, { transport: "recall", provider: "recallai_streaming" });
      ok("explicit recallai_streaming → sttWeak true", weak.sttWeak === true);
      // Explicit native is the strong path → not weak.
      const strong = gatherDoctorReport(repo, { transport: "recall", provider: "native" });
      ok("explicit native → sttWeak false", strong.sttWeak === false);
      // Vexa has no recall STT resolution.
      const vexa = gatherDoctorReport(repo, { transport: "vexa" });
      ok("vexa → stt null, not weak", vexa.stt === null && vexa.sttWeak === false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // --- archive listing --------------------------------------------------------
  {
    const repo = mkdtempSync(join(tmpdir(), "mex-doctor-arch-"));
    try {
      const meetings = join(repo, ".mex", "meetings");
      mkdirSync(join(meetings, "live"), { recursive: true });
      mkdirSync(join(meetings, "2026-01-02-standup"), { recursive: true });
      mkdirSync(join(meetings, "2026-01-05-review"), { recursive: true });
      const calls = listArchivedCalls(repo);
      ok("listArchivedCalls excludes live + sorts newest-first", calls.length === 2 && calls[0]!.name === "2026-01-05-review");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // --- readMeetingEventsForCall is robust on a non-scaffold repo --------------
  {
    const repo = mkdtempSync(join(tmpdir(), "mex-doctor-ev-"));
    try {
      const ev = readMeetingEventsForCall(repo, join(repo, ".mex"), join(repo, ".mex", "meetings", "x"));
      ok("readMeetingEventsForCall returns [] when there's no event log (no throw)", Array.isArray(ev) && ev.length === 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // --- Slice 4: decision-vs-scaffold diff (read-only heuristic) ----------------
  {
    const repo = mkdtempSync(join(tmpdir(), "mex-doctor-diff-"));
    try {
      const ctx = join(repo, ".mex", "context");
      mkdirSync(ctx, { recursive: true });
      writeFileSync(join(ctx, "auth.md"), "# Auth\n\nAuthentication and login use session cookies today.\n");
      const flags = scaffoldDiff(join(repo, ".mex"), ["move authentication login flow to OAuth tokens"]);
      ok("scaffoldDiff flags a decision overlapping a scaffold doc", flags.length === 1 && flags[0]!.file.includes("auth.md"));
      const none = scaffoldDiff(join(repo, ".mex"), ["order pizza for the offsite"]);
      ok("scaffoldDiff ignores unrelated decisions", none.length === 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // --- Slice 4: TUI defaults persistence --------------------------------------
  {
    const p = join(tmpdir(), `mex-tui-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    try {
      const saved = saveTuiDefaults({ ...DEFAULT_TUI_DEFAULTS, provider: "native", actions: false, keyterms: "Mex,OAuth" }, p);
      ok("saveTuiDefaults writes the file", saved === true);
      const loaded = loadTuiDefaults(p);
      ok("loadTuiDefaults round-trips values", loaded.provider === "native" && loaded.actions === false && loaded.keyterms === "Mex,OAuth");
      const missing = loadTuiDefaults(join(tmpdir(), "definitely-missing-" + Math.random() + ".json"));
      ok("loadTuiDefaults on missing file → defaults", missing.transport === "recall" && missing.actions === true);
    } finally {
      rmSync(p, { force: true });
    }
  }

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nall doctor tests passed");
}

main();
