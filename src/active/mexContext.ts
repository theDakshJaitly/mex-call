import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MexScaffoldStatus } from "../memory/scaffold.js";

/**
 * When a real mex scaffold is present, read a BOUNDED slice of its authored
 * context + patterns so the active loop can answer "what does the repo say
 * about this?". Read-only (rule 3) and capped so we never blow the model budget.
 *
 * Returns "" when there's no scaffold — the active loop simply runs without it.
 */
export function readMexContext(repoRoot: string, status: MexScaffoldStatus, maxChars = 6_000): string {
  if (!status.present) return "";
  const dirs = [join(status.mexDir, "context"), join(status.mexDir, "patterns")];
  const parts: string[] = [];
  let total = 0;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, f);
      try {
        if (!statSync(p).isFile()) continue;
        const body = readFileSync(p, "utf8").trim();
        if (!body) continue;
        const header = `--- ${f} ---\n`;
        const remaining = maxChars - total;
        if (header.length + body.length + 2 > remaining) {
          const slice = body.slice(0, Math.max(0, remaining - header.length));
          if (slice) parts.push(header + slice);
          return parts.join("\n").trim();
        }
        parts.push(header + body);
        total += header.length + body.length + 2;
      } catch {
        /* skip unreadable file */
      }
    }
  }

  return parts.join("\n").trim();
}
