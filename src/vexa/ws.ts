/**
 * Minimal structural typing for the WHATWG WebSocket (Node's built-in global,
 * available since Node 22; same shape the browser exposes). We use the built-in
 * rather than the `ws` package to keep the project's zero-runtime-deps rule, and
 * we avoid pulling the whole DOM lib into tsconfig just for this one type.
 */
export interface WSEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

export interface WSLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: WSEvent) => void): void;
}

type WSCtor = { new (url: string): WSLike };

/** readyState value for an open socket (WHATWG constant, always 1). */
export const WS_OPEN = 1;

/**
 * Resolve the built-in global WebSocket. Throws a clear, actionable error on a
 * runtime that predates it — only the Vexa transport needs this; Recall does not.
 */
export function getWebSocketCtor(): WSCtor {
  const ctor = (globalThis as unknown as { WebSocket?: WSCtor }).WebSocket;
  if (!ctor) {
    throw new Error(
      "The Vexa transport needs a built-in WebSocket (Node 22+). Upgrade Node, or use --transport recall."
    );
  }
  return ctor;
}
