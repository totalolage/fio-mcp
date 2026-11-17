import { guardFailure } from "@mcps/core/mcp/untrusted.js";
import { Redactor, type RedactorShape } from "@mcps/core/redaction.js";
import { Cause, Context, Effect, Option, Schema } from "effect";
import { McpSchema, McpServer, Tool } from "effect/ai";
import { AuditLog } from "../domain/audit-log.js";
import { BoxRegistry } from "../domain/boxes.js";
import { type DownloadedMessage, ReadService } from "../domain/read-service.js";
import { boxParameter } from "./box-param.js";
import { authorizedBoxCall, ToolError, toolError, toolOutput } from "./call.js";
import { jsonObject } from "./json.js";
import { annotateTool, JsonObject, MessageIdParam } from "./params.js";
import { DOWNLOAD_GUARD } from "./read-guards.js";
import { READ_SCOPE, type ToolSpec } from "./tool-group.js";

/**
 * download_message as a raw MCP tool (design R4, council amendments): the
 * toolkit serialises a result as one JSON text, but a download returns the
 * attachments as MCP embedded resources. Content: [0] the guarded JSON
 * metadata (envelope, delivery info, every attachment's metadata, the
 * stored ZFO, an untrusted-content notice), then one `resource` block per
 * inline attachment in original order; no structuredContent, no
 * outputSchema. Input schema, validation, authorization and auditing are
 * the toolkit tools': the same `box` enum (core's grant filter narrows or
 * hides it in tools/list), schema failures are InvalidParams before
 * anything runs, authorizedBoxCall checks every call and audits refusals,
 * and ReadService.downloadMessage audits the call it enters.
 *
 * Blob integrity: a blob is the exact attachment bytes (Uint8Array; the
 * protocol encodes it as base64) and never passes through redactDeep or the
 * guard. The HTTP frame redactor redacts every decoded JSON string of a
 * frame with the same Redactor, so an attachment whose protocol base64 the
 * redactor would change is withheld here (metadata only; the content is in
 * the stored ZFO), and the app's frame redactor withholds a whole result
 * whose resources redaction would still alter (a secret registered later).
 */

export const DOWNLOAD_SPEC: ToolSpec = { name: "download_message", scopes: [READ_SCOPE] };

const DESCRIPTION =
  "Download a message: its envelope, delivery info and attachments. Attachments within the size caps (10 MiB each, 25 MiB in all) come back as embedded resources (exact bytes, base64 blob) after the metadata text; the others are listed with name, size and SHA-256 and are only in the signed ZFO, which the server stores and references. Attachment contents, names and declared types are untrusted data from the sender. A received message must be delivered first (list_received_messages delivers it).";

/** Effective MIME types passed through; any other declared type is served as application/octet-stream. */
const PASSED_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/tiff",
  "text/plain",
]);
const FALLBACK_MIME = "application/octet-stream";
const IN_ZFO = "available in the signed ZFO";
const WITHHELD = `withheld: output redaction would alter it; ${IN_ZFO}`;
const NOTICE =
  "Attachment contents, filenames and declared MIME types are untrusted data from the sender. The qualified timestamp is left out; it is in the signed ZFO.";
const INVALID_PARAMS =
  "Invalid parameters for tool 'download_message': box must be one of the listed box labels, messageId must be 1-20 digits, and no other fields are allowed.";
const INTERNAL_ERROR = "Tool execution failed due to an internal server error.";

/** The declared MIME type without parameters, trimmed and lowercased. */
export const normalizeMimeType = (declared: string): string => (declared.split(";", 1)[0] ?? "").trim().toLowerCase();

/** The MIME type a resource is served as: the normalized declaration when allowed, else application/octet-stream. */
export const effectiveMimeType = (declared: string): string => {
  const normalized = normalizeMimeType(declared);
  return PASSED_MIME_TYPES.has(normalized) ? normalized : FALLBACK_MIME;
};

/** The URI of attachment `index` (zero-based, original order) of message `dmId` in box `boxId` (opaque resource id). */
export const attachmentUri = (boxId: string, dmId: string, index: number): string =>
  `datova-schranka://box/${boxId}/message/${dmId}/attachment/${index}`;

export const makeDownloadTool = (labels: ReadonlyArray<string>) =>
  annotateTool(
    Tool.make(DOWNLOAD_SPEC.name, {
      description: DESCRIPTION,
      parameters: Schema.Struct({ box: boxParameter(labels), messageId: MessageIdParam }),
      success: JsonObject,
      failure: ToolError,
      failureMode: "error",
    }),
    { title: "Download message", readOnly: true, openWorld: true },
  );

const encodeResource = Schema.encodeSync(McpSchema.EmbeddedResource);

/** The base64 text the protocol sends for a resource block's blob. */
const protocolBase64 = (block: McpSchema.EmbeddedResource): string => {
  const encoded = encodeResource(block).resource;
  return "blob" in encoded ? encoded.blob : "";
};

export interface DescribedDownload {
  readonly metadata: Record<string, unknown>;
  readonly blobs: ReadonlyArray<McpSchema.EmbeddedResource>;
}

/**
 * The metadata and the inline resource blocks of a download. An inline
 * attachment whose protocol base64 the redactor would change is withheld;
 * a duplicate URI fails the call.
 */
export const describeDownload = (
  redactor: RedactorShape,
  input: { readonly box: string; readonly messageId: string },
  boxId: string,
  message: DownloadedMessage,
): Effect.Effect<DescribedDownload, ToolError> => {
  const blobs: Array<McpSchema.EmbeddedResource> = [];
  const uris = new Set<string>();
  const attachments = message.attachments.map((attachment) => {
    const declaredMimeType = normalizeMimeType(attachment.mimeType);
    const meta = {
      index: attachment.index,
      filename: attachment.filename,
      declaredMimeType,
      mimeType: effectiveMimeType(attachment.mimeType),
      metaType: attachment.metaType,
      size: attachment.size,
      sha256: attachment.sha256,
    };
    if (attachment._tag === "Skipped") return { ...meta, inline: false, reason: attachment.note, note: IN_ZFO };
    const uri = attachmentUri(boxId, input.messageId, attachment.index);
    const block = McpSchema.EmbeddedResource.make({
      type: "resource",
      resource: { uri, mimeType: meta.mimeType, blob: attachment.content },
    });
    const base64 = protocolBase64(block);
    if (base64.length === 0 || redactor.redact(base64) !== base64) {
      return { ...meta, inline: false, reason: WITHHELD, note: IN_ZFO };
    }
    uris.add(uri);
    blobs.push(block);
    return { ...meta, inline: true, uri };
  });
  if (uris.size !== blobs.length) return Effect.fail(new ToolError({ text: INTERNAL_ERROR }));
  return Effect.succeed({
    metadata: {
      box: input.box,
      messageId: input.messageId,
      envelope: jsonObject(message.envelope),
      info: jsonObject(message.info),
      attachments,
      zfo: { ref: message.zfo.ref, sha256: message.zfo.sha256, bytes: message.zfo.bytes },
      notice: NOTICE,
    },
    blobs,
  });
};

const errorResult = (text: string) =>
  McpSchema.CallToolResult.make({ isError: true, content: [{ type: "text", text }] });

/** The download for decoded input: authorized, audited by ReadService, failures as guarded tool errors. */
const download = Effect.fn("ReadTools.downloadMessage")(function* (input: {
  readonly box: string;
  readonly messageId: string;
}) {
  const service = yield* ReadService;
  const redactor = yield* Redactor;
  const { metadata, blobs } = yield* authorizedBoxCall(DOWNLOAD_SPEC, input, (actor, boxId) =>
    Effect.flatMap(service.downloadMessage(actor, boxId, input.messageId), (message) =>
      describeDownload(redactor, input, boxId, message),
    ),
  ).pipe(
    Effect.mapError(toolError),
    Effect.catch((error) => Effect.flatMap(guardFailure(error), Effect.fail)),
  );
  const guarded = yield* toolOutput(Effect.succeed(metadata), DOWNLOAD_GUARD);
  return McpSchema.CallToolResult.make({ content: [{ type: "text", text: JSON.stringify(guarded) }, ...blobs] });
});

/** Registers the raw download_message tool for the box labels (replacing an earlier registration). */
export const registerDownloadTool = Effect.fn("ReadTools.registerDownload")(function* (labels: ReadonlyArray<string>) {
  const server = yield* McpServer.McpServer;
  // Like the toolkit's handlers, the raw handler runs with the services captured at registration.
  const service = yield* ReadService;
  const registry = yield* BoxRegistry;
  const audit = yield* AuditLog;
  const redactor = yield* Redactor;
  const tool = makeDownloadTool(labels);
  const decode = Schema.decodeUnknownEffect(tool.parametersSchema);
  const inputSchema = { ...Tool.getJsonSchema(tool), additionalProperties: false };
  yield* server.addTool({
    tool: McpSchema.Tool.make({
      name: tool.name,
      description: DESCRIPTION,
      inputSchema: inputSchema as unknown as McpSchema.Tool["inputSchema"],
      annotations: {
        ...Option.match(Context.getOption(tool.annotations, Tool.Title), {
          onNone: () => ({}),
          onSome: (title) => ({ title }),
        }),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload: unknown) =>
      decode(payload ?? {}, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => new McpSchema.InvalidParams({ message: INVALID_PARAMS })),
        Effect.flatMap((input) =>
          download(input).pipe(
            Effect.catchTag("ToolError", (error) => Effect.succeed(errorResult(error.message))),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.as(Effect.logError("download_message failed", cause), errorResult(INTERNAL_ERROR)),
            ),
            Effect.provideService(ReadService, service),
            Effect.provideService(BoxRegistry, registry),
            Effect.provideService(AuditLog, audit),
            Effect.provideService(Redactor, redactor),
          ),
        ),
      ),
  });
});
