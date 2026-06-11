import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * mex ships bundled with mex-call (the `mex-agent` dependency), so users get mex
 * without a separate install — they can `mex-call setup` (or any `mex-call mex
 * <cmd>`) whenever they want to light up the scaffold. We resolve the bundled
 * CLI from mex-call's own node_modules rather than relying on a global `mex`.
 */
export function resolveMexBin(): string {
  const pkgPath = require.resolve("mex-agent/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.mex;
  if (!binRel) throw new Error("mex-agent does not declare a `mex` bin");
  return join(dirname(pkgPath), binRel);
}

/** Run the bundled mex CLI with `args` in `cwd`, inheriting stdio. Resolves to exit code. */
export function runMex(args: string[], cwd: string): Promise<number> {
  let bin: string;
  try {
    bin = resolveMexBin();
  } catch (err) {
    process.stderr.write(`[mex-call] bundled mex not found: ${(err as Error).message}\n`);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: "inherit", cwd });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(`[mex-call] failed to run mex: ${err.message}\n`);
      resolve(1);
    });
  });
}
