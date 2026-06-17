/**
 * Unit tests for the Slice 5 cost/usage meter + markdown export. Pure functions,
 * so they're exercised directly.
 *
 * Run:  npx tsx src/tui/meter.test.ts
 */
import { estimateUsage, buildMarkdownReport, CLAUDE_CALL_USD, ASSEMBLY_PER_MIN_USD } from "./meter.js";
import type { LiveState } from "./store.js";

let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   — ${name}`);
  else {
    failures++;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function main(): void {
  // --- estimateUsage -----------------------------------------------------------
  {
    const u = estimateUsage({ compactions: 3, wakeCount: 5, repoActions: 1, elapsedMs: 600_000, usingAssembly: true });
    ok("brainCalls = compactions + wakes + repoActions", u.brainCalls === 9);
    ok("brainUsd = brainCalls × per-call", Math.abs(u.brainUsd - 9 * CLAUDE_CALL_USD) < 1e-9);
    ok("sttMinutes from elapsedMs", Math.abs(u.sttMinutes - 10) < 1e-9);
    ok("sttUsd = minutes × per-min", Math.abs(u.sttUsd - 10 * ASSEMBLY_PER_MIN_USD) < 1e-9);
    ok("totalUsd = brain + stt", Math.abs(u.totalUsd - (u.brainUsd + u.sttUsd)) < 1e-9);
  }
  {
    const noStt = estimateUsage({ compactions: 0, wakeCount: 2, repoActions: 0, elapsedMs: 600_000, usingAssembly: false });
    ok("no STT minutes when not using AssemblyAI", noStt.sttMinutes === 0 && noStt.sttUsd === 0);
    ok("brain cost still counts", noStt.brainCalls === 2);
  }

  // --- buildMarkdownReport -----------------------------------------------------
  {
    const view = {
      liveExists: true,
      status: { callName: "standup" } as LiveState["status"],
      transcript: [],
      activity: [],
      summary: "Shipping v2 Friday.",
      decisions: ["ship v2 Friday"],
      actionItems: ["@alex migrate db"],
      openQuestions: ["deprecate offset?"],
      participants: { present: ["Daksh", "Alex"], left: ["Carol"] },
      wakeEvents: [],
    } as LiveState;
    const md = buildMarkdownReport(view);
    ok("markdown has a title with the call name", /# mex-call · standup/.test(md));
    ok("markdown has Summary + Decisions + Actions + Open questions", /## Summary/.test(md) && /## Decisions/.test(md) && /## Action items/.test(md) && /## Open questions/.test(md));
    ok("markdown bullets the items", /- ship v2 Friday/.test(md) && /- @alex migrate db/.test(md));
    ok("markdown lists participants", /present: Daksh, Alex/.test(md) && /left: Carol/.test(md));
  }
  {
    const empty = buildMarkdownReport({
      liveExists: false, status: null, transcript: [], activity: [], summary: "",
      decisions: [], actionItems: [], openQuestions: [], participants: { present: [], left: [] }, wakeEvents: [],
    } as LiveState);
    ok("empty call → just a title, no throw", /# mex-call/.test(empty) && !/## Decisions/.test(empty));
  }

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nall meter tests passed");
}

main();
