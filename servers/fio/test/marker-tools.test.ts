import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Sink, Stdio, Stream } from "effect";
import { SERVER_INFO, ToolsLive } from "../src/app.js";
import type { MarkerTools } from "../src/config.js";
import { layerStdio } from "../src/transport/stdio.js";
import { testConfig, testServices } from "./support/transport.js";

const MARKER = ["get_new_transactions", "set_download_marker"];

/** Lists the tools over stdio and calls `set_download_marker` by name (SEC-10). */
const overStdio = Effect.fnUntraced(function* (markerTools: MarkerTools) {
  const stdin = yield* Queue.unbounded<Uint8Array>();
  const stdout = yield* Queue.unbounded<string>();
  const release = yield* Deferred.make<void>();
  const record = (chunk: string | Uint8Array) =>
    Queue.offer(stdout, typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  const platformStdio = Stdio.layerTest({ stdin: Stream.fromQueue(stdin), stdout: () => Sink.forEach(record) });
  const server = yield* Effect.forkScoped(
    Layer.launch(
      ToolsLive.pipe(
        Layer.provide(layerStdio(SERVER_INFO)),
        Layer.provide(platformStdio),
        Layer.provide(testServices({ ...testConfig(), markerTools }, release)),
      ),
    ),
  );
  const send = (message: object) => Queue.offer(stdin, new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  const request = Effect.fnUntraced(function* (message: object) {
    yield* send(message);
    return JSON.parse(yield* Effect.raceFirst(Queue.take(stdout), Fiber.join(server)));
  });
  yield* request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = yield* request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const call = yield* request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "set_download_marker", arguments: { account: "main", movementId: 1 } },
  });
  return { names: list.result.tools.map((t: { name: string }) => t.name) as Array<string>, call };
});

describe("FIO_MCP_MARKER_TOOLS over stdio (SEC-10)", () => {
  it.live("disabled: neither marker tool is registered or listed", () =>
    Effect.gen(function* () {
      const { names, call } = yield* overStdio("disabled");
      for (const name of MARKER) assert.notInclude(names, name);
      assert.strictEqual(call.error.message, "Tool 'set_download_marker' not found");
    }).pipe(Effect.scoped),
  );

  it.live("enabled: both marker tools are listed", () =>
    Effect.gen(function* () {
      const { names } = yield* overStdio("enabled");
      for (const name of MARKER) assert.include(names, name);
    }).pipe(Effect.scoped),
  );
});
