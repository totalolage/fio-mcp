/**
 * The SendService over its real collaborators (in-memory SQLite, AuditLog, BoxRegistry,
 * BoxClients, BoxLocks, RecipientTiers) with a fake ISDS transport and a test SendAuthority.
 *
 * `makeSendHarness` builds everything except the service, so a test can plant rows (e.g.
 * 'dispatching' filings for startup recovery) before `start` builds a SendService over the same
 * database; `start` can run again to model a restart. `sendHarness` is the same, started.
 */
import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { Context, Deferred, Effect, Layer, Option, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import type { AuditActor } from "../../../../src/domain/audit-log.js";
import { AuditLog } from "../../../../src/domain/audit-log.js";
import { BoxClients } from "../../../../src/domain/box-clients.js";
import { BoxLocks } from "../../../../src/domain/box-locks.js";
import { type Box, BoxRegistry } from "../../../../src/domain/boxes.js";
import { DataKey, DomainConfig, type DomainConfigShape } from "../../../../src/domain/config.js";
import { type RecipientTier, RecipientTiers } from "../../../../src/domain/recipient-tiers.js";
import {
  type SendCaller,
  type SendMessageRequest,
  SendService,
  type SendServiceShape,
} from "../../../../src/domain/send/api.js";
import { sendServiceLayer } from "../../../../src/domain/send/service.js";
import type { IsdsClientShape } from "../../../../src/isds/client.js";
import type { IsdsTransportFailure } from "../../../../src/isds/errors.js";
import type { IsdsSoapRequest, IsdsSoapResponse } from "../../../../src/isds/transport.js";
import { fakeIsdsTransports, loginResponder, passwordCredentials } from "../../support/fake-isds.js";
import { DATA_KEY } from "../../support/registry-harness.js";
import { makeTestSendAuthority, type TestSendAuthorityOptions } from "./authority.js";
import { patchRawFiling, type RawFilingRow, type RawNonceRow, rawFiling, rawFilings, rawNonces, sendDatabase } from "./database.js";
import { checkDataBoxReply, createMessageReply, sentMessagesReply } from "./isds-replies.js";
import { RECIPIENT_DB_ID, SENDER_DB_ID, sendRequest } from "./requests.js";

/** 2026-11-17T09:00:00Z, the harness's starting TestClock time. */
export const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

export const SENDER_LOGIN = "sender-user";

export const CALLER: SendCaller = { grantId: "grant_1", clientId: "client_1", subject: "user_1" };
export const OTHER_CALLER: SendCaller = { grantId: "grant_2", clientId: "client_2", subject: "user_2" };
export const ADMIN: AuditActor = { kind: "admin", subject: "admin" };

/** The ISDS operations a send touches. */
export type SendOperation = "CheckDataBox" | "CreateMessage" | "GetListOfSentMessages";

/**
 * A scripted ISDS reply: a response for every call, or a callback given the request and its
 * 1-based call number for that operation (fail with a transport failure, die, or never answer).
 */
export type ScriptedReply =
  | IsdsSoapResponse
  | ((request: IsdsSoapRequest, call: number) => Effect.Effect<IsdsSoapResponse, IsdsTransportFailure>);

export interface SendHarnessOptions {
  /** Recipient dbID → tier, set before the service starts (default: RECIPIENT_DB_ID → "full"). */
  readonly tiers?: Readonly<Record<string, RecipientTier>>;
  readonly verdicts?: TestSendAuthorityOptions["verdicts"];
  /** DomainConfig overrides (e.g. approvalNonceTtl, pendingTtl). */
  readonly config?: Partial<Omit<DomainConfigShape, "dataDir">>;
}

/** An audit_log row as stored, with detail_json also parsed. */
export interface AuditRow {
  readonly actor_kind: string;
  readonly grant_id: string | null;
  readonly action: string;
  readonly box_id: string | null;
  readonly outcome: string;
  readonly detail_json: string;
  readonly detail: unknown;
}

const defaultReplies: Record<SendOperation, ScriptedReply> = {
  CheckDataBox: checkDataBoxReply(1),
  CreateMessage: (_request, call) => Effect.succeed(createMessageReply(dmIdOf(call))),
  GetListOfSentMessages: sentMessagesReply([]),
};

/** The dmID the default CreateMessage reply assigns to its `call`-th call: 1000001, 1000002, … */
export const dmIdOf = (call: number): string => String(1_000_000 + call);

export const makeSendHarness = Effect.fn("makeSendHarness")(function* (options: SendHarnessOptions = {}) {
  yield* TestClock.setTime(T0);

  const scripted = new Map<string, ScriptedReply>(Object.entries(defaultReplies));
  const counts = new Map<string, number>();
  const arrivals = new Map<string, Deferred.Deferred<void>>();
  const arrival = (operation: string): Deferred.Deferred<void> => {
    const existing = arrivals.get(operation);
    if (existing !== undefined) return existing;
    const made = Deferred.makeUnsafe<void>();
    arrivals.set(operation, made);
    return made;
  };

  const isds = fakeIsdsTransports(
    loginResponder({ [SENDER_LOGIN]: SENDER_DB_ID }, (_config, request) =>
      Effect.suspend(() => {
        const call = (counts.get(request.operation) ?? 0) + 1;
        counts.set(request.operation, call);
        const reply = scripted.get(request.operation);
        let answer: Effect.Effect<IsdsSoapResponse, IsdsTransportFailure>;
        if (reply === undefined) answer = Effect.die(`send harness: no scripted reply for ${request.operation}`);
        else if (typeof reply === "function") answer = reply(request, call);
        else answer = Effect.succeed(reply);
        return Deferred.succeed(arrival(request.operation), undefined).pipe(Effect.andThen(answer));
      }),
    ),
  );
  const authority = makeTestSendAuthority({ verdicts: options.verdicts });

  const infrastructure = Layer.mergeAll(
    sendDatabase(),
    isds.layer,
    Layer.succeed(Redactor, makeRedactor([])),
    DataKey.layer(DATA_KEY),
    DomainConfig.layer({ dataDir: "/nonexistent", ...options.config }),
    BoxLocks.Default,
    authority.layer,
  );
  const registry = BoxRegistry.Default.pipe(Layer.provideMerge(infrastructure));
  // The real BoxClients, with CreateMessage replaceable for failures the real client only raises
  // before the transport (IsdsInvalidRequest, IsdsMessageTooLarge, IsdsConfigError, IsdsCredentialsError).
  let createOverride: IsdsClientShape["createMessage"] | undefined;
  const clients = Layer.effect(
    BoxClients,
    Effect.gen(function* () {
      const real = yield* BoxClients;
      return BoxClients.of({
        use: (boxId, f) =>
          real.use(boxId, (client) => {
            const override = createOverride;
            if (override === undefined) return f(client);
            return f({
              ...client,
              createMessage: (input) =>
                Effect.suspend(() => {
                  counts.set("CreateMessage", (counts.get("CreateMessage") ?? 0) + 1);
                  return Deferred.succeed(arrival("CreateMessage"), undefined).pipe(Effect.andThen(override(input)));
                }),
            });
          }),
      });
    }),
  ).pipe(Layer.provide(BoxClients.Default));
  const services = Layer.mergeAll(clients, AuditLog.Default, RecipientTiers.Default).pipe(
    Layer.provideMerge(registry),
  );
  const context = yield* Layer.build(services);
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, context);

  const box: Box = yield* provide(
    Effect.gen(function* () {
      const boxes = yield* BoxRegistry;
      return yield* boxes.add({
        label: "Sender",
        environment: "production",
        credentials: passwordCredentials(SENDER_LOGIN),
      });
    }),
  ).pipe(Effect.orDie);

  const setTier = (recipient: string, tier: RecipientTier): Effect.Effect<void> =>
    provide(
      Effect.gen(function* () {
        const tiers = yield* RecipientTiers;
        yield* tiers.set(box.id, recipient, tier);
      }),
    ).pipe(Effect.orDie);
  const initialTiers: Readonly<Record<string, RecipientTier>> = options.tiers ?? { [RECIPIENT_DB_ID]: "full" };
  for (const [recipient, tier] of Object.entries(initialTiers)) {
    yield* setTier(recipient, tier);
  }

  /** Builds a SendService over the harness (startup recovery runs here); call again to model a restart. */
  const tryStart = Layer.build(sendServiceLayer).pipe(Effect.map((built) => Context.get(built, SendService)), provide);
  const start: Effect.Effect<SendServiceShape, never, Scope.Scope> = Effect.orDie(tryStart);

  const audit = (action?: string): Effect.Effect<ReadonlyArray<AuditRow>> =>
    provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<Omit<AuditRow, "detail">>`
          SELECT actor_kind, grant_id, action, box_id, outcome, detail_json FROM audit_log ORDER BY rowid`;
        return rows
          .filter((row) => action === undefined || row.action === action)
          .map((row) => ({ ...row, detail: JSON.parse(row.detail_json) as unknown }));
      }),
    ).pipe(Effect.orDie);

  return {
    box,
    context,
    isds,
    authority,
    start,
    tryStart,
    /** Runs an effect that needs the harness services (SqlClient, BoxRegistry, …). */
    provide,
    /** A valid request from the harness box (sendRequest with boxId set). */
    request: (overrides: Partial<SendMessageRequest> = {}): SendMessageRequest =>
      sendRequest({ boxId: box.id, ...overrides }),
    setTier,
    /** Scripts `operation`'s replies from now on (replaces the default). */
    reply: (operation: SendOperation, reply: ScriptedReply): Effect.Effect<void> =>
      Effect.sync(() => {
        scripted.set(operation, reply);
      }),
    /** How many requests `operation` has received. */
    calls: (operation: SendOperation): number => counts.get(operation) ?? 0,
    /** Completes once `operation` has received its first request. */
    reached: (operation: SendOperation): Effect.Effect<void> => Deferred.await(arrival(operation)),
    /** audit_log rows in insertion order, optionally only one action's. */
    audit,
    /** The stored filings row (dies when it is missing). */
    filing: (id: string): Effect.Effect<RawFilingRow> =>
      provide(rawFiling(id)).pipe(
        Effect.orDie,
        Effect.flatMap(Option.match({ onNone: () => Effect.die(`no filing ${id}`), onSome: Effect.succeed })),
      ),
    filings: provide(rawFilings).pipe(Effect.orDie) as Effect.Effect<ReadonlyArray<RawFilingRow>>,
    nonces: provide(rawNonces).pipe(Effect.orDie) as Effect.Effect<ReadonlyArray<RawNonceRow>>,
    patchFiling: (id: string, columns: Readonly<Record<string, unknown>>): Effect.Effect<void> =>
      provide(patchRawFiling(id, columns)).pipe(Effect.orDie),
    /** Runs raw SQL (e.g. a trigger that makes a write fail). */
    exec: (statement: string): Effect.Effect<void> =>
      provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(statement);
        }),
      ).pipe(Effect.orDie),
    /** Removes the harness box from the registry. */
    removeBox: provide(
      Effect.gen(function* () {
        const boxes = yield* BoxRegistry;
        yield* boxes.remove(box.id);
      }),
    ).pipe(Effect.orDie),
    /**
     * Replaces CreateMessage on the box's client (undefined: back to the transport). The
     * replacement counts as a CreateMessage call.
     */
    overrideCreateMessage: (override: IsdsClientShape["createMessage"] | undefined): Effect.Effect<void> =>
      Effect.sync(() => {
        createOverride = override;
      }),
    advance: (millis: number): Effect.Effect<void> => TestClock.adjust(millis),
  };
});

export type SendHarness = Effect.Success<ReturnType<typeof makeSendHarness>>;

/** makeSendHarness, started: the harness plus its SendService. */
export const sendHarness = Effect.fn("sendHarness")(function* (options: SendHarnessOptions = {}) {
  const harness = yield* makeSendHarness(options);
  const service = yield* harness.start;
  return { ...harness, service };
});
