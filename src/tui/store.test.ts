/**
 * Unit tests for the TUI's file-tailing store — the read side of the front-end.
 * The TUI never imports the loops; it reads the files Dashboard.ts + MeetingMemory
 * write. These tests assert the parse + snapshot logic against fixture files, so a
 * change to the on-disk shape is caught here, not in a live call.
 *
 * Run:  npx tsx src/tui/store.test.ts
 */
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LiveStore,
  parseTranscript,
  parseActivity,
  parseList,
  parseSummary,
  parseParticipants,
  parseWakeLog,
  type StatusJson,
} from "./store.js";
import { MeetingMemory } from "../memory/MeetingMemory.js";

let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   — ${name}`);
  else {
    failures++;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

const sampleStatus: StatusJson = {
  callName: "standup",
  meetUrl: "https://meet.google.com/abc-defg-hij",
  botName: "Mex (notetaker)",
  status: "recording",
  ended: false,
  startedAt: 1_000,
  updatedAt: 5_000,
  elapsedMs: 4_000,
  counts: { participants: 3, decisions: 2, actionItems: 1, openQuestions: 1 },
};

function main(): void {
  // --- parseTranscript ---------------------------------------------------------
  {
    const lines = parseTranscript(
      [
        "# Transcript (full, append-only — never sent to the model)",
        "",
        "- [12:43:01] Daksh: let's ship friday",
        "- [12:43:09] Alex: i'll do the migration",
        "- [12:43:15] Operator (typed): Mex, log that",
        "garbage line that should be ignored",
      ].join("\n")
    );
    ok("parseTranscript keeps only bullet lines", lines.length === 3, `got ${lines.length}`);
    ok("parseTranscript extracts ts/speaker/text", lines[0]?.ts === "12:43:01" && lines[0]?.speaker === "Daksh" && lines[0]?.text === "let's ship friday");
    ok("parseTranscript handles a speaker with parens", lines[2]?.speaker === "Operator (typed)" && lines[2]?.text === "Mex, log that");
  }

  // --- parseActivity -----------------------------------------------------------
  {
    const acts = parseActivity(
      ["12:43:02 🎙 Daksh: \"Mex, log that\"", "12:43:03 ✅ replied: Logged decision", "", "  "].join("\n")
    );
    ok("parseActivity parses icon + text", acts.length === 2 && acts[0]?.icon === "🎙" && acts[1]?.text === "replied: Logged decision");
    ok("parseActivity skips blank lines", acts.length === 2);
  }

  // --- LiveStore.read against fixtures -----------------------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), "mex-store-"));
    try {
      writeFileSync(join(dir, "status.json"), JSON.stringify(sampleStatus));
      writeFileSync(join(dir, "transcript.md"), "- [12:43:01] Daksh: hello\n- [12:43:05] Alex: hi\n");
      writeFileSync(join(dir, "activity.log"), "12:43:02 🧠 memory compacted\n");
      const store = new LiveStore(dir);
      const state = store.read();
      ok("read(): liveExists true when files present", state.liveExists === true);
      ok("read(): status parsed", state.status?.callName === "standup" && state.status?.counts.decisions === 2);
      ok("read(): transcript parsed", state.transcript.length === 2 && state.transcript[1]?.speaker === "Alex");
      ok("read(): activity parsed", state.activity.length === 1 && state.activity[0]?.icon === "🧠");

      // fingerprint changes when a file is rewritten (drives watch()).
      const fp1 = store.fingerprint();
      // Bump mtime deterministically into the future (writes within the same ms
      // wouldn't change mtimeMs on coarse clocks).
      const future = new Date(Date.now() + 1000);
      writeFileSync(join(dir, "transcript.md"), "- [12:43:01] Daksh: hello\n- [12:43:05] Alex: hi\n- [12:43:10] Daksh: bye\n");
      utimesSync(join(dir, "transcript.md"), future, future);
      const fp2 = store.fingerprint();
      ok("fingerprint changes after a write", fp1 !== fp2, `${fp1} === ${fp2}`);
      ok("read() reflects the appended line", store.read().transcript.length === 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- Robustness: missing dir + half-written status.json ----------------------
  {
    const store = new LiveStore(join(tmpdir(), "mex-store-does-not-exist-" + Math.random()));
    const state = store.read();
    ok("read(): missing dir → liveExists false, null status, empty lists", state.liveExists === false && state.status === null && state.transcript.length === 0);
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "mex-store-bad-"));
    try {
      writeFileSync(join(dir, "status.json"), "{ half written"); // invalid JSON
      writeFileSync(join(dir, "transcript.md"), "- [00:00:01] X: y\n");
      const state = new LiveStore(dir).read();
      ok("read(): invalid status.json → status null, no throw, transcript still parsed", state.status === null && state.transcript.length === 1 && state.liveExists === true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- Slice 2: memory list / summary / participants parsers -------------------
  {
    const items = parseList("# Decisions\n\n- [12:43:01] ship v2 Friday\n- deprecate offset param\n#notbullet\n");
    ok("parseList strips '- ' and optional [ts], skips header", items.length === 2 && items[0] === "ship v2 Friday" && items[1] === "deprecate offset param");
  }
  {
    const s = parseSummary("# Rolling summary\n\n_Compacted continuously; stays bounded._\n\nTeam is finalizing the v2 launch.\n");
    ok("parseSummary strips header + italic preamble", s === "Team is finalizing the v2 launch.", JSON.stringify(s));
  }
  {
    const p = parseParticipants("# Participants\n\n## In the call\n- Alice\n- Bob\n\n## Left\n- Carol\n");
    ok("parseParticipants splits present/left", p.present.join(",") === "Alice,Bob" && p.left.join(",") === "Carol");
    const empty = parseParticipants("# Participants\n\n## In the call\n- (none yet)\n");
    ok("parseParticipants drops the (none yet) placeholder", empty.present.length === 0);
  }

  // --- Slice 2: LiveStore.read() surfaces memory + participants ----------------
  {
    const dir = mkdtempSync(join(tmpdir(), "mex-store-mem-"));
    try {
      writeFileSync(join(dir, "status.json"), JSON.stringify(sampleStatus));
      writeFileSync(join(dir, "rolling-summary.md"), "# Rolling summary\n\n_x_\n\nShipping v2 Friday.\n");
      writeFileSync(join(dir, "decisions.md"), "# Decisions\n\n- [12:00:00] ship v2 Friday\n");
      writeFileSync(join(dir, "action-items.md"), "# Action items\n\n- [12:00:01] @alex migrate db\n");
      writeFileSync(join(dir, "open-questions.md"), "# Open questions\n\n- [12:00:02] deprecate offset?\n");
      writeFileSync(join(dir, "participants.md"), "# Participants\n\n## In the call\n- Daksh\n- Alex\n");
      const state = new LiveStore(dir).read();
      ok("read(): summary parsed", state.summary === "Shipping v2 Friday.");
      ok("read(): decisions/actions/questions parsed", state.decisions[0] === "ship v2 Friday" && state.actionItems[0] === "@alex migrate db" && state.openQuestions[0] === "deprecate offset?");
      ok("read(): participants parsed", state.participants.present.join(",") === "Daksh,Alex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- Slice 4: wake-log parsing ----------------------------------------------
  {
    const wakes = parseWakeLog(
      [
        JSON.stringify({ ts: 1, speaker: "Daksh", utterance: "Mex log that", source: "voice", addressed: true, action: "log_decision", outcome: "addressed" }),
        "{ broken json",
        JSON.stringify({ ts: 2, speaker: "Alex", utterance: "next call that", source: "voice", addressed: false, action: "none", outcome: "ignored" }),
      ].join("\n")
    );
    ok("parseWakeLog keeps valid JSONL lines, skips garbage", wakes.length === 2 && wakes[1]!.outcome === "ignored");
  }

  // --- Slice 4: editListItem round-trips through the files the store reads -----
  {
    const repo = mkdtempSync(join(tmpdir(), "mex-edit-"));
    try {
      const mem = new MeetingMemory(repo);
      mem.init();
      mem.appendDecisions(["ship v1", "drop feature X", "use OAuth"]);
      mem.editListItem("decision", 1, "KEEP feature X"); // edit middle
      mem.editListItem("decision", 0, ""); // remove first
      const state = new LiveStore(mem.liveDir).read();
      ok(
        "editListItem edits + removes, store reflects it",
        state.decisions.length === 2 && state.decisions[0] === "KEEP feature X" && state.decisions[1] === "use OAuth"
      );
      // wake-log read via the store
      writeFileSync(
        join(mem.liveDir, "wake-log.jsonl"),
        JSON.stringify({ ts: 1, speaker: "X", utterance: "Mex test", source: "typed", addressed: true, action: "answer", outcome: "addressed" }) + "\n"
      );
      ok("LiveStore.read() surfaces wakeEvents", new LiveStore(mem.liveDir).read().wakeEvents.length === 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nall store tests passed");
}

main();
