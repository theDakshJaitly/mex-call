import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * mex runs "backwards" here: the meeting agent is the wedge, mex is the
 * enhancer. We detect a real mex scaffold to enrich context when present, but
 * NEVER block on it — if absent we run standalone and nudge the user.
 */
export interface MexScaffoldStatus {
  /** A real mex scaffold (not just our meetings folder) is present. */
  present: boolean;
  /** What we matched on, for logging. */
  reason: string;
  mexDir: string;
}

export function detectMexScaffold(repoRoot: string): MexScaffoldStatus {
  const mexDir = join(repoRoot, ".mex");

  // A real scaffold is identified by its config (holds scaffold_id) or the
  // authored context/router files — not by our own .mex/meetings/ folder.
  const markers: Array<[string, string]> = [
    [join(mexDir, "config.json"), ".mex/config.json"],
    [join(mexDir, "ROUTER.md"), ".mex/ROUTER.md"],
    [join(mexDir, "context"), ".mex/context/"],
  ];

  for (const [path, label] of markers) {
    if (existsSync(path)) {
      return { present: true, reason: `found ${label}`, mexDir };
    }
  }

  return { present: false, reason: "no .mex scaffold markers found", mexDir };
}

/** The nudge shown when running standalone, so usage pulls people toward mex. */
export const MEX_NUDGE = [
  "",
  "  💡 No mex scaffold detected — running standalone.",
  "     mex-call works fine like this, but with mex set up it gets smarter:",
  "     it can read your architecture, conventions and past decisions, and the",
  "     call memory it writes joins the same compounding scaffold.",
  "     Set it up:  npx mex@latest setup   (https://github.com/theDakshJaitly/mex)",
  "",
].join("\n");
