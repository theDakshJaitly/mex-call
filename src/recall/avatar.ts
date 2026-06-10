import { existsSync, readFileSync, statSync } from "node:fs";

export interface BotAvatar {
  kind: "jpeg";
  b64Data: string;
}

/** Recall's documented limit for the camera image. */
const MAX_AVATAR_BYTES = 1_300_000;

/**
 * Load a JPEG avatar and base64-encode it for Recall's automatic_video_output.
 * Returns null if the file is missing (caller continues without an avatar) and
 * warns if it exceeds Recall's size/format expectations.
 *
 * Recall wants JPEG, 16:9, ~1280x720, <=1.3MB. We only hard-check size; the
 * bundled asset already matches the rest.
 */
export function loadAvatar(path: string, warn: (msg: string) => void = () => {}): BotAvatar | null {
  if (!existsSync(path)) {
    warn(`avatar not found at ${path} — joining without a custom tile`);
    return null;
  }
  const bytes = statSync(path).size;
  if (bytes > MAX_AVATAR_BYTES) {
    warn(`avatar is ${bytes} bytes (> ${MAX_AVATAR_BYTES}); Recall may reject it`);
  }
  return { kind: "jpeg", b64Data: readFileSync(path).toString("base64") };
}
