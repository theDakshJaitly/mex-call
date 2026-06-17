import { spawn } from "node:child_process";

/**
 * Operator notifications (Slice 5). Terminal bell is universal; the desktop ping
 * is macOS-only via osascript and strictly best-effort (never throws, never
 * blocks the render loop). Both are off by default — opt in with the `n` key.
 */

/** Ring the terminal bell. Written straight to stdout as a control char; Ink's
 *  next frame paints over it harmlessly. */
export function bell(): void {
  try {
    process.stdout.write("\x07");
  } catch {
    /* best-effort */
  }
}

let warned = false;

/** Fire a desktop notification (macOS). Silent no-op elsewhere / on failure. */
export function desktopNotify(title: string, message: string): void {
  if (process.platform !== "darwin") return;
  try {
    const script = `display notification ${quote(message)} with title ${quote(title)}`;
    const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
    child.on("error", () => {
      if (!warned) warned = true; // swallow; don't spam
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

/** AppleScript string literal escaping. */
function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 180)}"`;
}
