import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The control channel: a small typed contract the TUI uses to drive a running
 * `mex-call join` runtime over a local Unix domain socket. It is ADDITIVE to the
 * existing runtime.pid / SIGINT `leave` path (which stays intact for headless
 * use) — the socket exists because the headline interactive feature, type-to-Mex,
 * is a request/response with a human waiting on confirmation, which a watched
 * command-file does mushily (see TUI_EXECUTION_PLAN §2).
 *
 * Wire format: newline-delimited JSON. One {@link ControlRequest} per line in,
 * one {@link ControlAck} per line out, correlated by `id`. Keep it minimal.
 */

/** Bump when the request/ack shape changes incompatibly. The server rejects
 *  requests carrying a different major version rather than guessing. */
export const CONTROL_PROTOCOL_VERSION = 1;

/** The three captured-item kinds the operator can promote/edit (Slice 4). */
export type CapturedKind = "decision" | "action" | "question";

/** A command the operator issues against the live call. Discriminated on `type`. */
export type ControlCommand =
  /** Operator-typed "Mex, …" command → ActiveLoop.injectCommand (bypasses STT). */
  | { type: "inject-mex-command"; text: string }
  /** Post a plain message into the meeting chat as the bot. */
  | { type: "send-chat"; text: string }
  /** Force the passive loop to recompact the rolling summary now. */
  | { type: "force-summary" }
  /** Promote a transcript line into a captured item (the manual safety net for
   *  when automatic detection misses a decision). Writes to the memory files. */
  | { type: "promote-item"; text: string; kind: CapturedKind }
  /** Edit (or, with text="", remove) an already-captured item before finalize. */
  | { type: "edit-item"; kind: CapturedKind; index: number; text: string }
  /** Graceful leave → finalize/archive (same end-state as SIGINT). */
  | { type: "leave" }
  /** Liveness check; the ack confirms the runtime is listening. */
  | { type: "ping" };

export type ControlCommandType = ControlCommand["type"];

export interface ControlRequest {
  /** Protocol version (see {@link CONTROL_PROTOCOL_VERSION}). */
  v: number;
  /** Correlation id, echoed back on the matching ack. */
  id: string;
  cmd: ControlCommand;
}

/** Optional payload a handler can return (e.g. a human-readable confirmation). */
export interface ControlResult {
  message?: string;
}

export type ControlAck =
  | { v: number; id: string; ok: true; result?: ControlResult }
  | { v: number; id: string; ok: false; error: string };

/**
 * The runtime's control socket path, derived deterministically from its pid so
 * the TUI (which knows the spawned child's pid) and a standalone caller (which
 * reads runtime.pid) resolve the SAME path without a discovery file.
 *
 * Lives in the OS temp dir, NOT under .mex/meetings/live/, for two reasons:
 * (1) finalize moves live/ into the archive, which would drag a socket file with
 * it; (2) macOS caps the socket path (sun_path) at ~104 bytes and deep repo
 * paths blow that — tmpdir keeps it short.
 */
export function controlSocketPath(pid: number): string {
  return join(tmpdir(), `mex-call-control-${pid}.sock`);
}
