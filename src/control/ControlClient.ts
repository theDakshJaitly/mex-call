import net from "node:net";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlAck,
  type ControlResult,
} from "./protocol.js";

/**
 * TUI side of the control channel. Holds one persistent connection to the
 * runtime's socket and correlates each command with its ack by `id`, so
 * type-to-Mex gets a real delivery confirmation (not fire-and-forget). All sends
 * are awaitable; a send before/without a live connection rejects rather than
 * hanging.
 */

let nextId = 0;

interface Pending {
  resolve: (result: ControlResult | undefined) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ControlClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 30_000
  ) {}

  /** Connect to the runtime socket. Rejects if it isn't listening yet. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding("utf8");
      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        socket.on("error", () => this.failAll(new Error("control socket error")));
        socket.on("close", () => this.failAll(new Error("control socket closed")));
        socket.on("data", (chunk: string) => this.onData(chunk));
        this.socket = socket;
        resolve();
      });
    });
  }

  /** Send a command and resolve with the runtime's ack (or reject on nak/timeout). */
  send(cmd: ControlCommand): Promise<ControlResult | undefined> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.destroyed) return reject(new Error("not connected to runtime"));
      const id = String(nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("control command timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, id, cmd }) + "\n");
    });
  }

  close(): void {
    this.failAll(new Error("client closed"));
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onAck(line);
    }
  }

  private onAck(line: string): void {
    let ack: ControlAck;
    try {
      ack = JSON.parse(line) as ControlAck;
    } catch {
      return; // ignore garbage
    }
    const p = this.pending.get(ack.id);
    if (!p) return;
    this.pending.delete(ack.id);
    clearTimeout(p.timer);
    if (ack.ok) p.resolve(ack.result);
    else p.reject(new Error(ack.error));
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
