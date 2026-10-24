import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Sink, Stdio, Stream } from "effect";
import { SERVER_INFO, ToolsLive } from "../src/app.js";
import { makeCacheToolkit } from "../src/mcp/cache-tools.js";
import { makeFioToolkit } from "../src/mcp/fio-tools.js";
import { layerStdio } from "../src/transport/stdio.js";
import { ACCOUNT_NAMES, FIO_TOKEN, testConfig, testServices } from "./support/transport.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The stdio app on in-memory stdin/stdout; returns a request function and every stdout chunk. */
const startStdio = Effect.fnUntraced(function* () {
  const stdin = yield* Queue.unbounded<Uint8Array>();
  const stdout = yield* Queue.unbounded<string>();
  const written: Array<string> = [];
  const release = yield* Deferred.make<void>();
  const record = (chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
    written.push(text);
    return Queue.offer(stdout, text);
  };
  const platformStdio = Stdio.layerTest({
    stdin: Stream.fromQueue(stdin),
    stdout: () => Sink.forEach(record),
  });
  // Launched on its own fiber: the stdio protocol interrupts the fiber that
  // built it once stdout closes, as a process would exit.
  const server = yield* Effect.forkScoped(
    Layer.launch(
      ToolsLive.pipe(
        Layer.provide(layerStdio(SERVER_INFO)),
        Layer.provide(platformStdio),
        Layer.provide(testServices(testConfig(), release)),
      ),
    ),
  );
  const send = (message: object) => Queue.offer(stdin, encoder.encode(`${JSON.stringify(message)}\n`));
  const request = Effect.fnUntraced(function* (message: object) {
    yield* send(message);
    // A server that fails to start fails the test instead of hanging it.
    return JSON.parse(yield* Effect.raceFirst(Queue.take(stdout), Fiber.join(server)));
  });
  return { send, request, written };
});

describe("stdio transport", () => {
  it.live("speaks MCP on stdout, one JSON-RPC frame per write, with secrets redacted", () =>
    Effect.gen(function* () {
      const { send, request, written } = yield* startStdio();

      const init = yield* request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      assert.strictEqual(init.result.serverInfo.name, SERVER_INFO.name);
      yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

      const list = yield* request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      assert.deepStrictEqual(
        list.result.tools.map((t: { name: string }) => t.name).sort(),
        [
          ...Object.keys(makeFioToolkit(ACCOUNT_NAMES).tools),
          ...Object.keys(makeCacheToolkit(ACCOUNT_NAMES).tools),
        ].sort(),
      );

      // McpServer echoes the unknown tool name in its own error text.
      const unknown = yield* request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: FIO_TOKEN, arguments: {} },
      });
      assert.strictEqual(unknown.id, 3);
      assert.strictEqual(unknown.error.message, "Tool '***' not found");

      for (const chunk of written) {
        assert.notInclude(chunk, FIO_TOKEN);
        assert.isTrue(chunk.endsWith("\n"), "each write is one newline-terminated frame");
        const frame = JSON.parse(chunk);
        assert.strictEqual(frame.jsonrpc, "2.0");
      }
      assert.strictEqual(written.length, 3);
    }).pipe(Effect.scoped),
  );
});
