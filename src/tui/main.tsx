import React from "react";
import { render } from "ink";
import { App } from "./App.js";

export interface RunTuiOptions {
  /** Repo whose .mex/meetings/ the call writes into. */
  repo: string;
  /** Local webhook port for the spawned `join` (recall transport). */
  port: number;
  /** Optional pre-filled Meet link (skips the prejoin prompt). */
  meetUrl?: string;
}

/**
 * Launch the Ink command centre. The caller (cli.ts) owns the TTY guard; we
 * disable Ink's own Ctrl-C handling so the App can leave the call gracefully
 * before exiting.
 */
export async function runTui(opts: RunTuiOptions): Promise<void> {
  const { waitUntilExit } = render(<App {...opts} />, { exitOnCtrlC: false });
  await waitUntilExit();
}
