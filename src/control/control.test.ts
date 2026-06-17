/**
 * Unit tests for the control channel — the genuinely-new, load-bearing wiring of
 * Slice 1 (the socket that carries type-to-Mex / send-chat / force-summary /
 * leave from the TUI into a running runtime). A live call can't be driven here,
 * so THESE TESTS are the substitute: a real ControlServer + ControlClient talking
 * over a real Unix domain socket, asserting each command reaches the right
 * handler and the ack/nak contract holds.
 *
 * Run:  npx tsx src/control/control.test.ts
 * (Not bundled by tsup — only cli.ts/index.ts/tui are entries — but typechecked.)
 */
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer, type ControlHandlers } from "./ControlServer.js";
import { ControlClient } from "./ControlClient.js";
import { CONTROL_PROTOCOL_VERSION } from "./protocol.js";

let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   — ${name}`);
  else {
    failures++;
    console.error(`FAIL — ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function uniqueSocketPath(tag: string): string {
  return join(tmpdir(), `mex-call-test-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/** Records which handlers fired and with what args. */
function spyHandlers() {
  const calls: { name: string; arg?: string }[] = [];
  const handlers: ControlHandlers = {
    injectMexCommand: (text) => void calls.push({ name: "injectMexCommand", arg: text }),
    sendChat: (text) => void calls.push({ name: "sendChat", arg: text }),
    forceSummary: () => void calls.push({ name: "forceSummary" }),
    promoteItem: (text, kind) => void calls.push({ name: "promoteItem", arg: `${kind}:${text}` }),
    editItem: (kind, index, text) => void calls.push({ name: "editItem", arg: `${kind}:${index}:${text}` }),
    leave: () => {
      calls.push({ name: "leave" });
      return { message: "leaving" };
    },
  };
  return { handlers, calls };
}

/** Send one raw newline-JSON line and resolve with the first response line. */
function rawRoundTrip(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.write(line + "\n"));
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      resolve(chunk.trim());
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

async function main(): Promise<void> {
  // --- Happy path: every command reaches its handler and is acked --------------
  {
    const path = uniqueSocketPath("dispatch");
    const { handlers, calls } = spyHandlers();
    const server = new ControlServer(path, handlers);
    await server.start();
    const client = new ControlClient(path, 5_000);
    await client.connect();

    const pong = await client.send({ type: "ping" });
    ok("ping is acked with pong", pong?.message === "pong", JSON.stringify(pong));

    const inj = await client.send({ type: "inject-mex-command", text: "Mex, log that we ship Friday" });
    ok("inject-mex-command acked", inj?.message === "injected");
    ok(
      "inject-mex-command reached injectMexCommand with the text",
      calls.some((c) => c.name === "injectMexCommand" && c.arg === "Mex, log that we ship Friday")
    );

    await client.send({ type: "send-chat", text: "hello room" });
    ok(
      "send-chat reached sendChat with the text",
      calls.some((c) => c.name === "sendChat" && c.arg === "hello room")
    );

    await client.send({ type: "force-summary" });
    ok("force-summary reached forceSummary", calls.some((c) => c.name === "forceSummary"));

    await client.send({ type: "promote-item", text: "ship v2 Friday", kind: "decision" });
    ok(
      "promote-item reached promoteItem with text + kind",
      calls.some((c) => c.name === "promoteItem" && c.arg === "decision:ship v2 Friday")
    );

    await client.send({ type: "edit-item", kind: "action", index: 2, text: "" });
    ok(
      "edit-item (remove) reached editItem with index",
      calls.some((c) => c.name === "editItem" && c.arg === "action:2:")
    );

    const leave = await client.send({ type: "leave" });
    ok("leave acked with handler's message", leave?.message === "leaving");
    ok("leave reached leave handler", calls.some((c) => c.name === "leave"));

    client.close();
    await server.stop();
  }

  // --- Version mismatch is rejected, not silently coerced ----------------------
  {
    const path = uniqueSocketPath("version");
    const { handlers, calls } = spyHandlers();
    const server = new ControlServer(path, handlers);
    await server.start();
    const resp = await rawRoundTrip(
      path,
      JSON.stringify({ v: CONTROL_PROTOCOL_VERSION + 99, id: "x", cmd: { type: "ping" } })
    );
    const parsed = JSON.parse(resp);
    ok("wrong protocol version → ok:false", parsed.ok === false, resp);
    ok("version mismatch did not invoke any handler", calls.length === 0);
    await server.stop();
  }

  // --- Malformed JSON gets a nak, doesn't crash the server ---------------------
  {
    const path = uniqueSocketPath("malformed");
    const { handlers } = spyHandlers();
    const server = new ControlServer(path, handlers);
    await server.start();
    const resp = await rawRoundTrip(path, "{not json");
    const parsed = JSON.parse(resp);
    ok("malformed JSON → ok:false", parsed.ok === false, resp);
    await server.stop();
  }

  // --- A throwing handler surfaces as a nak with the error message -------------
  {
    const path = uniqueSocketPath("throw");
    const handlers: ControlHandlers = {
      injectMexCommand: () => {
        throw new Error("boom");
      },
      sendChat: () => {},
      forceSummary: () => {},
      promoteItem: () => {},
      editItem: () => {},
      leave: () => {},
    };
    const server = new ControlServer(path, handlers);
    await server.start();
    const client = new ControlClient(path, 5_000);
    await client.connect();
    let rejected = "";
    try {
      await client.send({ type: "inject-mex-command", text: "x" });
    } catch (err) {
      rejected = (err as Error).message;
    }
    ok("throwing handler → client send rejects with the error", rejected === "boom", rejected);
    client.close();
    await server.stop();
  }

  // --- send() before connect rejects rather than hanging -----------------------
  {
    const client = new ControlClient(uniqueSocketPath("noconnect"), 1_000);
    let rejected = "";
    try {
      await client.send({ type: "ping" });
    } catch (err) {
      rejected = (err as Error).message;
    }
    ok("send without a connection rejects", rejected === "not connected to runtime", rejected);
  }

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nall control-channel tests passed");
}

void main();
