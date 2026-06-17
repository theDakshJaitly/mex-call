import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlRequest,
  type ControlAck,
  type ControlResult,
  type CapturedKind,
} from "./protocol.js";

/**
 * Runtime side of the control channel. Listens on the Unix domain socket and
 * dispatches each command to the handler the composition root (`cli.ts join`)
 * provides. Best-effort by design: if the socket can't be opened the call still
 * runs headless — control is a convenience, never a dependency.
 */

export interface ControlHandlers {
  /** Operator-typed "Mex, …" command → ActiveLoop.injectCommand. */
  injectMexCommand(text: string): void | Promise<void>;
  /** Post a chat message into the meeting as the bot. */
  sendChat(text: string): void | Promise<void>;
  /** Force a passive-loop recompaction now. */
  forceSummary(): void | Promise<void>;
  /** Promote a transcript line into a captured item (writes to memory files). */
  promoteItem(text: string, kind: CapturedKind): void | Promise<void>;
  /** Edit (text="" removes) an already-captured item before finalize. */
  editItem(kind: CapturedKind, index: number, text: string): void | Promise<void>;
  /** Graceful leave → finalize/archive. May return a confirmation. */
  leave(): ControlResult | void | Promise<ControlResult | void>;
}

export class ControlServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly handlers: ControlHandlers,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  /** Bind + listen. Resolves on success; rejects so the caller can fall back. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // A stale socket file from a crashed run would make listen() throw
      // EADDRINUSE; clear it first (we own this pid-keyed path).
      try {
        if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
      } catch {
        /* fall through; listen will report if it's truly blocked */
      }
      const server = net.createServer((socket) => this.onConnection(socket));
      server.on("error", (err) => {
        if (!this.server) reject(err); // failed before listening → let caller fall back
        else this.log(`control socket error: ${(err as Error).message}`);
      });
      server.listen(this.socketPath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  /** Close the server, drop live connections, and remove the socket file. */
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((res) => server.close(() => res()));
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      /* best-effort */
    }
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // Newline-delimited JSON: process each complete line, keep the remainder.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) void this.handleLine(socket, line);
      }
    });
    socket.on("error", () => this.sockets.delete(socket));
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let req: ControlRequest | undefined;
    try {
      req = JSON.parse(line) as ControlRequest;
    } catch {
      return this.reply(socket, { v: CONTROL_PROTOCOL_VERSION, id: "?", ok: false, error: "malformed JSON" });
    }
    const id = typeof req.id === "string" ? req.id : "?";
    if (req.v !== CONTROL_PROTOCOL_VERSION) {
      return this.reply(socket, {
        v: CONTROL_PROTOCOL_VERSION,
        id,
        ok: false,
        error: `protocol version mismatch (server ${CONTROL_PROTOCOL_VERSION}, client ${req.v})`,
      });
    }
    try {
      const result = await this.dispatch(req.cmd);
      this.reply(socket, { v: CONTROL_PROTOCOL_VERSION, id, ok: true, result: result ?? undefined });
    } catch (err) {
      this.reply(socket, { v: CONTROL_PROTOCOL_VERSION, id, ok: false, error: (err as Error).message });
    }
  }

  private async dispatch(cmd: ControlCommand): Promise<ControlResult | void> {
    switch (cmd.type) {
      case "inject-mex-command":
        await this.handlers.injectMexCommand(cmd.text);
        return { message: "injected" };
      case "send-chat":
        await this.handlers.sendChat(cmd.text);
        return { message: "sent to chat" };
      case "force-summary":
        await this.handlers.forceSummary();
        return { message: "summarizing" };
      case "promote-item":
        await this.handlers.promoteItem(cmd.text, cmd.kind);
        return { message: `promoted to ${cmd.kind}` };
      case "edit-item":
        await this.handlers.editItem(cmd.kind, cmd.index, cmd.text);
        return { message: cmd.text ? "edited" : "removed" };
      case "leave":
        return (await this.handlers.leave()) ?? { message: "leaving" };
      case "ping":
        return { message: "pong" };
      default:
        // Exhaustiveness: a new command added to the union without a handler.
        throw new Error(`unknown command: ${(cmd as { type?: string }).type}`);
    }
  }

  private reply(socket: net.Socket, ack: ControlAck): void {
    if (socket.writable) socket.write(JSON.stringify(ack) + "\n");
  }
}
