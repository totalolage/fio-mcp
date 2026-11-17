import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { McpProtocol } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { afterEach } from "vitest";
import { ToolPolicy } from "../src/mcp/grants.js";
import { makeRedactor, Redactor } from "../src/redaction.js";
import { Resources } from "../src/resources.js";
import { Auth } from "../src/transport/auth.js";
import { makeFrameRedactor, WITHHELD_RESOURCES_TEXT, withheldResult } from "../src/transport/frame-redaction.js";
import { type HttpTransportConfig, httpRouterApp } from "../src/transport/http.js";

/**
 * makeFrameRedactor's `protectEmbeddedResources`: a result that embeds a
 * resource is withheld whole when redaction would change it, and every other
 * frame is redacted exactly as without the option.
 */

const SECRET = "late-secret-0123456789";
const encoder = new TextEncoder();

const base64 = (text: string) => Buffer.from(text).toString("base64");

/** A tools/call response with guarded metadata and one embedded resource. */
const resourceResult = (id: number | string, blobText: string, uri = "isds://message/1/attachment/0") => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [
      { type: "text", text: '{"attachments":1}' },
      { type: "resource", resource: { uri, mimeType: "application/pdf", blob: base64(blobText) } },
    ],
  },
});

const textResult = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

const json = (message: unknown) => `${JSON.stringify(message)}\n`;
const sse = (message: unknown) => `data: ${JSON.stringify(message)}\n\n`;

/** A redactor that learns SECRET only after the frame was built. */
const lateRedactor = () => {
  const redactor = makeRedactor([]);
  return { redactor, registerLate: () => redactor.register([base64(SECRET), SECRET]) };
};

describe("frame redaction with protectEmbeddedResources", () => {
  it("withholds a JSON resource result when a secret registered after the handler would alter its blob", () => {
    const { redactor, registerLate } = lateRedactor();
    const frames = makeFrameRedactor(redactor, { protectEmbeddedResources: true });
    const frame = json(resourceResult(7, SECRET));
    registerLate();
    const out = frames.text(frame);
    assert.strictEqual(out, json(withheldResult(7)));
    const message = JSON.parse(out);
    assert.strictEqual(message.id, 7);
    assert.deepStrictEqual(message.result, {
      isError: true,
      content: [{ type: "text", text: WITHHELD_RESOURCES_TEXT }],
    });
    assert.notInclude(out, base64(SECRET));
  });

  it("withholds when redaction would change only the URI or the metadata text of a resource result", () => {
    const { redactor, registerLate } = lateRedactor();
    const frames = makeFrameRedactor(redactor, { protectEmbeddedResources: true });
    registerLate();
    const inUri = resourceResult(1, "clean bytes", `isds://message/${SECRET}`);
    assert.strictEqual(frames.text(json(inUri)), json(withheldResult(1)));
    const inText = resourceResult(2, "clean bytes");
    inText.result.content[0] = { type: "text", text: `metadata ${SECRET}` };
    assert.strictEqual(frames.text(json(inText)), json(withheldResult(2)));
  });

  it("passes a resource result redaction would not change byte for byte", () => {
    const { redactor, registerLate } = lateRedactor();
    const frames = makeFrameRedactor(redactor, { protectEmbeddedResources: true });
    registerLate();
    const bytes = encoder.encode(json(resourceResult(3, "clean bytes")));
    assert.strictEqual(frames.chunk(bytes), bytes);
  });

  it("withholds the resource event of an SSE body and redacts the other events as before", () => {
    const { redactor, registerLate } = lateRedactor();
    const frames = makeFrameRedactor(redactor, { protectEmbeddedResources: true });
    const plain = makeFrameRedactor(redactor);
    const body = `${sse(textResult(1, `text ${SECRET}`))}: keepalive\n\n${sse(resourceResult("call-2", SECRET))}${sse(resourceResult(3, "clean bytes"))}`;
    registerLate();
    const out = frames.text(body);
    assert.strictEqual(
      out,
      `${sse(textResult(1, "text ***"))}: keepalive\n\n${sse(withheldResult("call-2"))}${sse(resourceResult(3, "clean bytes"))}`,
    );
    // Only the resource event differs from redaction without the option.
    const events = (text: string) => text.split("\n\n");
    assert.deepStrictEqual(
      events(out).map((event, i) => event === events(plain.text(body))[i]),
      [true, true, false, true, true],
    );
  });

  it("withholds a resource SSE chunk delivered as bytes", () => {
    const { redactor, registerLate } = lateRedactor();
    const frames = makeFrameRedactor(redactor, { protectEmbeddedResources: true });
    const chunk = encoder.encode(sse(resourceResult(4, SECRET)));
    registerLate();
    assert.strictEqual(new TextDecoder().decode(frames.chunk(chunk)), sse(withheldResult(4)));
  });

  it("redacts the id of a withheld result like any other string", () => {
    const { redactor, registerLate } = lateRedactor();
    const frames = makeFrameRedactor(redactor, { protectEmbeddedResources: true });
    registerLate();
    assert.strictEqual(frames.text(json(resourceResult(`id-${SECRET}`, SECRET))), json(withheldResult("id-***")));
  });

  it("checks each message of a JSON-RPC batch on its own", () => {
    const { redactor, registerLate } = lateRedactor();
    const frames = makeFrameRedactor(redactor, { protectEmbeddedResources: true });
    registerLate();
    const batch = [textResult(1, SECRET), resourceResult(2, SECRET), resourceResult(3, "clean bytes")];
    assert.deepStrictEqual(JSON.parse(frames.text(json(batch))), [
      textResult(1, "***"),
      withheldResult(2),
      resourceResult(3, "clean bytes"),
    ]);
  });

  it("leaves results without embedded resources as redaction without the option does", () => {
    const { redactor, registerLate } = lateRedactor();
    const on = makeFrameRedactor(redactor, { protectEmbeddedResources: true });
    const off = makeFrameRedactor(redactor);
    registerLate();
    const link = { jsonrpc: "2.0", id: 5, result: { content: [{ type: "resource_link", uri: `x://${SECRET}` }] } };
    const error = { jsonrpc: "2.0", id: 6, error: { code: -32602, message: `bad ${SECRET}` } };
    const body = `${json(textResult(1, SECRET))}${json(link)}${json(error)}`;
    assert.strictEqual(on.text(body), off.text(body));
    assert.notInclude(on.text(body), SECRET);
    assert.strictEqual(on.text(sse(textResult(2, SECRET))), off.text(sse(textResult(2, SECRET))));
  });

  it("is off by default: a resource blob is redacted in place", () => {
    const { redactor, registerLate } = lateRedactor();
    const frames = makeFrameRedactor(redactor);
    const frame = json(resourceResult(8, SECRET));
    registerLate();
    const message = JSON.parse(frames.text(frame));
    assert.strictEqual(message.result.content[1].resource.blob, "***");
    assert.deepStrictEqual(
      makeFrameRedactor(redactor, { protectEmbeddedResources: false }).text(frame),
      frames.text(frame),
    );
  });
});

/**
 * The HTTP transport plumbing: HttpTransportConfig.protectEmbeddedResources
 * reaches the response guard. A route under `app` answers with a resource
 * result and registers the secret before returning, as a late registration
 * would.
 */
describe("HTTP response redaction with protectEmbeddedResources", () => {
  const BASE = "http://mcp.example.test";
  const CONFIG: HttpTransportConfig = { host: "127.0.0.1", port: 0, allowedOrigins: [], allowedHosts: [], trustedProxies: [] };

  const handlers: Array<{ readonly dispose: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const handler of handlers.splice(0)) await handler.dispose();
  });

  const routes = Layer.unwrap(
    Effect.gen(function* () {
      const redactor = yield* Redactor;
      return Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/resource.json",
          Effect.sync(() => {
            const body = encoder.encode(json(resourceResult(1, SECRET)));
            redactor.register([base64(SECRET)]);
            return HttpServerResponse.uint8Array(body, { contentType: "application/json" });
          }),
        ),
        HttpRouter.add(
          "GET",
          "/resource.sse",
          Effect.sync(() => {
            const events = [sse(textResult(1, "progress")), sse(resourceResult(2, SECRET))];
            redactor.register([base64(SECRET)]);
            return HttpServerResponse.stream(Stream.fromIterable(events.map((event) => encoder.encode(event))), {
              contentType: "text/event-stream",
            });
          }),
        ),
      );
    }),
  );

  const start = (config: HttpTransportConfig) => {
    const app = httpRouterApp(
      routes,
      Auth.Open,
      { name: "frame-demo", version: "0.0.0", instructions: "", protocols: [McpProtocol.v2025_06_18] },
      config,
    ).pipe(
      Layer.provide(Layer.succeed(Resources, Resources.of({ list: Effect.succeed([]), changes: Stream.empty }))),
      Layer.provide(ToolPolicy.layer({ scopes: () => [], resourceless: () => true, resourceParameter: "box" })),
      Layer.provide(Redactor.layer(Effect.succeed([]))),
      Layer.provide(HttpServer.layerServices),
    );
    const web = HttpRouter.toWebHandler(app, { disableLogger: true });
    handlers.push(web);
    return async (path: string) => {
      const response = await web.handler(new Request(`${BASE}${path}`));
      assert.strictEqual(response.status, 200);
      return response.text();
    };
  };

  it("withholds JSON and SSE resource results when the app enables it", async () => {
    const get = start({ ...CONFIG, protectEmbeddedResources: true });
    assert.strictEqual(await get("/resource.json"), json(withheldResult(1)));
    assert.strictEqual(await get("/resource.sse"), `${sse(textResult(1, "progress"))}${sse(withheldResult(2))}`);
  });

  it("redacts the blob in place when the app leaves it off", async () => {
    const get = start(CONFIG);
    const message = JSON.parse(await get("/resource.json"));
    assert.strictEqual(message.id, 1);
    assert.strictEqual(message.result.content[1].resource.blob, "***");
  });
});
