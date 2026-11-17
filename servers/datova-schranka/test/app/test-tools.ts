/**
 * A test-only tool group for the composed app: one isds:read box tool, one
 * isds:send box tool, one resourceless tool, and two raw-output tools that
 * show what the HTTP layer does to a tool's result (frame redaction with the
 * tools' Redactor, embedded resources).
 */

import { Buffer } from "node:buffer";
import { Redactor } from "@mcps/core/redaction.js";
import { Context, Effect } from "effect";
import { McpSchema, McpServer } from "effect/ai";
import type { Features } from "../../src/app/app.js";
import { FEATURES } from "../../src/app/app.js";
import { BOX_PARAMETER, READ_SCOPE, SEND_SCOPE, type ToolGroup, type ToolSpec } from "../../src/mcp/tool-group.js";

export const READ_TOOL = "test_read_box";
export const SEND_TOOL = "test_send_box";
export const STATUS_TOOL = "test_status";
/** Returns `text` unredacted, after registering `secret` with the Redactor the tools get. */
export const ECHO_TOOL = "test_echo_raw";
/** Returns an embedded resource whose blob is the bytes `blob` (base64) encodes, unredacted. */
export const BLOB_TOOL = "test_blob";

export const RESOURCE_URI = "datova-schranka://test/blob";

const SPECS: ReadonlyArray<ToolSpec> = [
  { name: READ_TOOL, scopes: [READ_SCOPE] },
  { name: SEND_TOOL, scopes: [SEND_SCOPE] },
  { name: STATUS_TOOL, scopes: [READ_SCOPE], resourceless: true },
  { name: ECHO_TOOL, scopes: [READ_SCOPE], resourceless: true },
  { name: BLOB_TOOL, scopes: [READ_SCOPE], resourceless: true },
];

const text = (value: string) => McpSchema.CallToolResult.make({ content: [{ type: "text", text: value }] });

const boxSchema = (labels: ReadonlyArray<string>) => ({
  type: "object",
  properties: { [BOX_PARAMETER]: { type: "string", enum: [...labels] } },
  required: [BOX_PARAMETER],
  additionalProperties: false,
});

const stringsSchema = (...names: ReadonlyArray<string>) => ({
  type: "object",
  properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
  additionalProperties: false,
});

const tool = (name: string, inputSchema: object) =>
  McpSchema.Tool.make({ name, description: name, inputSchema: inputSchema as unknown as McpSchema.Tool["inputSchema"] });

/** What the tools saw: the Redactor instance each registration got. */
export const seen: { redactors: Array<Redactor["Service"]> } = { redactors: [] };

export const testToolGroup: ToolGroup<Redactor> = {
  specs: SPECS,
  register: (labels) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const redactor = yield* Redactor;
      seen.redactors.push(redactor);
      const add = (name: string, inputSchema: object, handle: (payload: Record<string, string>) => McpSchema.CallToolResult) =>
        server.addTool({
          tool: tool(name, inputSchema),
          annotations: Context.empty(),
          handle: (payload: Record<string, string> | undefined) => Effect.sync(() => handle(payload ?? {})),
        });
      yield* add(READ_TOOL, boxSchema(labels), (input) => text(`read ${input[BOX_PARAMETER]}`));
      yield* add(SEND_TOOL, boxSchema(labels), (input) => text(`send ${input[BOX_PARAMETER]}`));
      yield* add(STATUS_TOOL, stringsSchema(), () => text(`boxes: ${labels.join(", ")}`));
      yield* add(ECHO_TOOL, stringsSchema("secret", "text"), (input) => {
        if (input.secret !== undefined) redactor.register([input.secret]);
        return text(input.text ?? "");
      });
      yield* add(BLOB_TOOL, stringsSchema("blob"), (input) =>
        McpSchema.CallToolResult.make({
          content: [
            { type: "text", text: "the blob" },
            {
              type: "resource",
              resource: { uri: RESOURCE_URI, mimeType: "application/octet-stream", blob: new Uint8Array(Buffer.from(input.blob ?? "", "base64")) },
            },
          ],
        }),
      );
    }),
};

/** The production features with the test tool group instead of the production tools. */
export const TEST_FEATURES: Features = { ...FEATURES, toolGroups: [testToolGroup] };
