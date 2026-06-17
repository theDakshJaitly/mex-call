import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Persisted TUI defaults — the non-secret choices the Launch screen pre-fills
 * (transport, STT provider, toggles). Deliberately does NOT store API keys: a TUI
 * form is the wrong place to capture/write secrets, so keys stay in env / .env /
 * ~/.mex-call.env and the Settings screen only shows their presence.
 */
export interface TuiDefaults {
  transport: "recall" | "vexa";
  provider: string; // "" = auto-resolve (resolveStt)
  actions: boolean;
  botName: string; // "" = built-in default
  keyterms: string; // comma-separated; "" = default ["Mex"]
  model: string; // "" = default alias
}

export const DEFAULT_TUI_DEFAULTS: TuiDefaults = {
  transport: "recall",
  provider: "",
  actions: true,
  botName: "",
  keyterms: "",
  model: "",
};

export function tuiConfigPath(): string {
  return join(homedir(), ".mex-call.tui.json");
}

export function loadTuiDefaults(path = tuiConfigPath()): TuiDefaults {
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TuiDefaults>;
      return { ...DEFAULT_TUI_DEFAULTS, ...parsed };
    }
  } catch {
    /* fall through to defaults on a corrupt file */
  }
  return { ...DEFAULT_TUI_DEFAULTS };
}

export function saveTuiDefaults(d: TuiDefaults, path = tuiConfigPath()): boolean {
  try {
    writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}
