import type { GuardSpec } from "@mcps/core/mcp/untrusted.js";
import { Redactor } from "@mcps/core/redaction.js";
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { AuditLog } from "../domain/audit-log.js";
import { type Box, BoxRegistry } from "../domain/boxes.js";
import { DomainConfig } from "../domain/config.js";
import { ReadService } from "../domain/read-service.js";
import type { DataBoxOwnerInfo } from "../isds/databox.js";
import { FindDataBoxesQuery } from "../isds/databox.js";
import type { ListMessagesInput } from "../isds/message-lists.js";
import { boxParameter } from "./box-param.js";
import { authorizedBoxCall, authorizedCall, ToolError, toolActor, toolError, toolOutput } from "./call.js";
import type { Caller } from "./caller.js";
import { DOWNLOAD_SPEC, registerDownloadTool } from "./download-tool.js";
import { registerAuditedToolkit } from "./input-audit.js";
import { jsonObject, toJson } from "./json.js";
import {
  annotateTool,
  DataBoxIdParam,
  JsonObject,
  LimitParam,
  MessageIdParam,
  StatesParam,
  TimeParam,
  timeBound,
} from "./params.js";
import {
  DELIVERY_INFO_GUARD,
  FIND_GUARD,
  LIST_GUARD,
  MESSAGE_GUARD,
  STATE_CHANGES_GUARD,
  STATUS_GUARD,
} from "./read-guards.js";
import { SERVER_NAME, SERVER_VERSION } from "./server-info.js";
import { READ_SCOPE, type ToolGroup, type ToolSpec } from "./tool-group.js";

// --- Specs -----------------------------------------------------------------------------------

const read = (name: string, resourceless = false): ToolSpec =>
  resourceless ? { name, scopes: [READ_SCOPE], resourceless: true } : { name, scopes: [READ_SCOPE] };

const SPEC = {
  get_server_status: read("get_server_status", true),
  list_received_messages: read("list_received_messages"),
  list_sent_messages: read("list_sent_messages"),
  get_message: read("get_message"),
  get_delivery_info: read("get_delivery_info"),
  get_message_state_changes: read("get_message_state_changes"),
  find_data_box: read("find_data_box"),
  check_data_box: read("check_data_box"),
} as const;

/** Every isds:read tool, download_message included. */
export const READ_TOOL_SPECS: ReadonlyArray<ToolSpec> = [...Object.values(SPEC), DOWNLOAD_SPEC];

// --- Tool definitions ------------------------------------------------------------------------

const MAX_LIST_LIMIT = 1000;

const RECEIVED_DESCRIPTION =
  "List messages received in the box. CALLING THIS LEGALLY DELIVERS every not-yet-delivered message in the box (ISDS GetListOfReceivedMessages): delivery happens at this call, and legal deadlines start running from it. The filters (from, to, states) and the limit only narrow which records are returned; they do not limit what is delivered, which is every message that can be delivered. The returned records are not necessarily the complete delivered set. Only call it when the user wants the box's new messages delivered now.";

const tool = <const Name extends string, P extends Schema.Struct<Schema.Struct.Fields> | Tool.EmptyParams>(
  name: Name,
  description: string,
  parameters: P,
) => Tool.make(name, { description, parameters, success: JsonObject, failure: ToolError, failureMode: "error" });

/** The toolkit tools (download_message is a raw tool, download-tool.ts). The `box` enum lists `labels`. */
export function makeReadToolkit(labels: ReadonlyArray<string>) {
  const box = boxParameter(labels);
  const window = {
    from: Schema.optional(TimeParam("Earliest delivery or submission time")),
    to: Schema.optional(TimeParam("Latest delivery or submission time")),
  };
  const lookup = { title: "", readOnly: true, openWorld: true } as const;

  return Toolkit.make(
    annotateTool(
      tool(
        "get_server_status",
        "Show the data boxes your grant covers (label, box ID, owner), the ISDS environment and the server version. No ISDS call.",
        Tool.EmptyParams,
      ),
      { title: "Server status", readOnly: true, openWorld: false },
    ),
    annotateTool(
      tool(
        "list_received_messages",
        RECEIVED_DESCRIPTION,
        Schema.Struct({
          box,
          ...window,
          states: Schema.optional(StatesParam),
          limit: Schema.optional(LimitParam(MAX_LIST_LIMIT)),
        }),
      ),
      { title: "List received messages (delivers them)", readOnly: false, destructive: true, idempotent: true, openWorld: true },
    ),
    annotateTool(
      tool(
        "list_sent_messages",
        "List messages sent from the box, newest records first as ISDS returns them. Does not deliver anything.",
        Schema.Struct({
          box,
          ...window,
          states: Schema.optional(StatesParam),
          limit: Schema.optional(LimitParam(MAX_LIST_LIMIT)),
        }),
      ),
      { ...lookup, title: "List sent messages" },
    ),
    annotateTool(
      tool(
        "get_message",
        "Get a message's envelope (sender, recipient, annotation, references, state and times) without attachments. A received message must be delivered first (list_received_messages delivers it); for a sent message use get_delivery_info for its delivery events.",
        Schema.Struct({ box, messageId: MessageIdParam }),
      ),
      { ...lookup, title: "Get message envelope" },
    ),
    annotateTool(
      tool(
        "get_delivery_info",
        "Get a message's delivery information: envelope, state, delivery and acceptance times and the delivery events.",
        Schema.Struct({ box, messageId: MessageIdParam }),
      ),
      { ...lookup, title: "Get delivery info" },
    ),
    annotateTool(
      tool(
        "get_message_state_changes",
        "List state changes of the box's messages within a time window (message ID, time, new state). Does not deliver anything.",
        Schema.Struct({ box, ...window }),
      ),
      { ...lookup, title: "Get message state changes" },
    ),
    annotateTool(
      tool(
        "find_data_box",
        "Search the ISDS directory for data boxes with the box's credentials (FindDataBox2): by dbID, or by IČO (ic), firm name, person name, birth data or address. Does not deliver anything.",
        Schema.Struct({ box, query: FindDataBoxesQuery }),
      ),
      { ...lookup, title: "Find data box" },
    ),
    annotateTool(
      tool(
        "check_data_box",
        "Check whether a data box exists and can receive messages (CheckDataBox): returns its state (1 = accessible).",
        Schema.Struct({ box, dbID: DataBoxIdParam }),
      ),
      { ...lookup, title: "Check data box" },
    ),
  );
}

export type ReadToolkit = ReturnType<typeof makeReadToolkit>;

// --- Handlers --------------------------------------------------------------------------------

const ownerSummary = (owner: DataBoxOwnerInfo) =>
  toJson({
    dbType: owner.dbType,
    ic: owner.ic,
    firmName: owner.firmName,
    pnFirstName: owner.pnFirstName,
    pnLastName: owner.pnLastName,
  });

const boxStatus = (box: Box) => ({
  label: box.label,
  dbID: box.dbId,
  boxType: box.boxType,
  owner: ownerSummary(box.owner),
});

const listInput = (input: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly states?: ListMessagesInput["states"];
  readonly limit?: number | undefined;
}): ListMessagesInput => {
  const from = timeBound(input.from, "from");
  const to = timeBound(input.to, "to");
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
};

/** Leaves out the qualified timestamp (binary; it is in the stored ZFO). */
const withoutTimestamp = <T extends { readonly dmQTimestamp?: unknown }>(value: T): Omit<T, "dmQTimestamp"> => {
  const { dmQTimestamp: _timestamp, ...rest } = value;
  return rest;
};

export const makeReadHandlers = Effect.fn("ReadTools.handlers")(function* (toolkit: ReadToolkit) {
  const service = yield* ReadService;
  const registry = yield* BoxRegistry;
  const audit = yield* AuditLog;
  const config = yield* DomainConfig;
  const redactor = yield* Redactor;
  // Handlers run with no services of their own: the output path gets the ones captured here.
  const out = <A extends Record<string, unknown>, E>(
    effect: Effect.Effect<A, E, AuditLog | BoxRegistry | Redactor>,
    spec?: GuardSpec,
  ) =>
    toolOutput(effect, spec).pipe(
      Effect.provideService(AuditLog, audit),
      Effect.provideService(BoxRegistry, registry),
      Effect.provideService(Redactor, redactor),
    );

  const serverStatus = Effect.fn("ReadTools.serverStatus")(function* (caller: Caller) {
    const boxes = (yield* registry.list).filter((box) => caller.boxIds.has(box.id));
    // No service audits this call, so its success row is written here.
    yield* audit.record({
      actor: toolActor(caller),
      action: SPEC.get_server_status.name,
      outcome: "ok",
      detail: { boxes: boxes.length },
    });
    return {
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      environment: config.environment,
      grant: { scopes: [...caller.scopes].sort(), deliveryConsentVersion: caller.deliveryConsentVersion },
      boxes: boxes.map(boxStatus),
    };
  });

  return toolkit.of({
    get_server_status: () =>
      out(authorizedCall(SPEC.get_server_status, {}, serverStatus).pipe(Effect.mapError(toolError)), STATUS_GUARD),

    list_received_messages: (input) =>
      out(
        authorizedBoxCall(SPEC.list_received_messages, input, (actor, boxId) =>
          service.listReceivedMessages(actor, boxId, listInput(input)),
        ).pipe(
          Effect.map((result) => ({
            box: input.box,
            count: result.records.length,
            records: toJson(result.records),
            note: result.note,
          })),
          Effect.mapError(toolError),
        ),
        LIST_GUARD,
      ),

    list_sent_messages: (input) =>
      out(
        authorizedBoxCall(SPEC.list_sent_messages, input, (actor, boxId) =>
          service.listSentMessages(actor, boxId, listInput(input)),
        ).pipe(
          Effect.map((records) => ({ box: input.box, count: records.length, records: toJson(records) })),
          Effect.mapError(toolError),
        ),
        LIST_GUARD,
      ),

    get_message: (input) =>
      out(
        authorizedBoxCall(SPEC.get_message, input, (actor, boxId) =>
          service.getMessageEnvelope(actor, boxId, input.messageId),
        ).pipe(
          Effect.map((envelope) => ({ box: input.box, message: jsonObject(withoutTimestamp(envelope)) })),
          Effect.mapError(toolError),
        ),
        MESSAGE_GUARD,
      ),

    get_delivery_info: (input) =>
      out(
        authorizedBoxCall(SPEC.get_delivery_info, input, (actor, boxId) =>
          service.getDeliveryInfo(actor, boxId, input.messageId),
        ).pipe(
          Effect.map((info) => ({ box: input.box, deliveryInfo: jsonObject(withoutTimestamp(info)) })),
          Effect.mapError(toolError),
        ),
        DELIVERY_INFO_GUARD,
      ),

    get_message_state_changes: (input) =>
      out(
        authorizedBoxCall(SPEC.get_message_state_changes, input, (actor, boxId) => {
          const from = timeBound(input.from, "from");
          const to = timeBound(input.to, "to");
          return service.getMessageStateChanges(actor, boxId, {
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          });
        }).pipe(
          Effect.map((changes) => ({ box: input.box, count: changes.length, changes: toJson(changes) })),
          Effect.mapError(toolError),
        ),
        STATE_CHANGES_GUARD,
      ),

    find_data_box: (input) =>
      out(
        authorizedBoxCall(SPEC.find_data_box, input, (actor, boxId) => service.findDataBox(actor, boxId, input.query)).pipe(
          Effect.map((result) => ({
            box: input.box,
            outcome: result.outcome,
            truncated: result.truncated,
            boxes: toJson(result.boxes),
          })),
          Effect.mapError(toolError),
        ),
        FIND_GUARD,
      ),

    check_data_box: (input) =>
      out(
        authorizedBoxCall(SPEC.check_data_box, input, (actor, boxId) => service.checkDataBox(actor, boxId, input.dbID)).pipe(
          Effect.map((result) => ({ box: input.box, dbID: input.dbID, dbState: result.dbState })),
          Effect.mapError(toolError),
        ),
      ),
  });
});

// --- Group -----------------------------------------------------------------------------------

export type ReadToolServices = ReadService | BoxRegistry | AuditLog | Redactor | DomainConfig;

/**
 * The isds:read tools. `register` registers the toolkit tools and the raw
 * download_message tool for the box labels (again on every label change).
 */
export const readToolGroup: ToolGroup<ReadToolServices> = {
  specs: READ_TOOL_SPECS,
  register: Effect.fn("ReadTools.register")(function* (labels: ReadonlyArray<string>) {
    const toolkit = makeReadToolkit(labels);
    yield* registerAuditedToolkit(toolkit).pipe(Effect.provide(toolkit.toLayer(makeReadHandlers(toolkit))));
    yield* registerDownloadTool(labels);
  }),
};
