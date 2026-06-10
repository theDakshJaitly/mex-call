import { existsSync, readFileSync } from "node:fs";

/**
 * Tiny dependency-free .env loader. We keep deps minimal (commander only), so
 * rather than pull in dotenv we parse KEY=value lines ourselves. Existing
 * process.env values win (so real env overrides the file).
 */
export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
