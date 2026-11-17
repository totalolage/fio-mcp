import { createHash } from "node:crypto";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Scheduler } from "effect";
import { SqlClient } from "effect/sql";
import { type AuditActor, AuditLog, audited } from "../../src/domain/audit-log.js";
import { BoxClients } from "../../src/domain/box-clients.js";
import { BoxRegistry } from "../../src/domain/boxes.js";
import { DataKey, DomainConfig } from "../../src/domain/config.js";
import { ReadService } from "../../src/domain/read-service.js";
import { RecipientTiers } from "../../src/domain/recipient-tiers.js";
import { ZfoStore } from "../../src/domain/zfo-store.js";
import type { IsdsClientConfig } from "../../src/isds/config.js";
import type { IsdsSoapRequest, IsdsSoapResponse } from "../../src/isds/transport.js";
import { dmStatus, fixture, ok, soapResponse } from "../isds/fake-transport.js";
import { memoryDatabase } from "./support/database.js";
import { type FakeRespond, fakeIsdsTransports, loginKey, loginResponder, passwordCredentials } from "./support/fake-isds.js";
import { DATA_KEY } from "./support/registry-harness.js";

/**
 * The domain services over their real layers (SQLite, files, Redactor,
 * BoxRegistry → BoxClients → ReadService); only the ISDS transport is fake.
 */

const ALICE = { username: "alice-user", dbId: "abc1234" } as const;
const BOB = { username: "bob-user", dbId: "bcd2345" } as const;
const PASSWORD = (username: string) => `secret-of-${username}`;
const DM_ID = "8765432";
const actor: AuditActor = { kind: "tool", grantId: "grant_1", clientId: "client_1" };

const LOGINS = { [ALICE.username]: ALICE.dbId, [BOB.username]: BOB.dbId };

const cannedReplies: Readonly<Record<string, string>> = {
  GetListOfReceivedMessages: fixture("GetListOfReceivedMessages-multi.xml"),
  MessageDownload: fixture("MessageDownload.xml"),
  SignedMessageDownload: fixture("SignedMessageDownload.xml"),
};

/** Logins per LOGINS, the canned replies above, and `override` first for anything it answers. */
const responder = (
  override?: (
    config: IsdsClientConfig,
    request: IsdsSoapRequest,
  ) => Effect.Effect<IsdsSoapResponse, never> | undefined,
): FakeRespond =>
  loginResponder(LOGINS, (config, request) => {
    const overridden = override?.(config, request);
    if (overridden !== undefined) return overridden;
    const xml = cannedReplies[request.operation];
    return Effect.succeed(ok(xml ?? ""));
  });

const servicesLayer = (respond: FakeRespond, dataDir: string) => {
  const isds = fakeIsdsTransports(respond);
  const infrastructure = Layer.mergeAll(
    memoryDatabase(),
    isds.layer,
    Layer.succeed(Redactor, makeRedactor([])),
    DataKey.layer(DATA_KEY),
    DomainConfig.layer({ dataDir }),
    NodeFileSystem.layer,
  );
  const registry = BoxRegistry.Default.pipe(Layer.provideMerge(infrastructure));
  const services = Layer.mergeAll(BoxClients.Default, AuditLog.Default, ZfoStore.Default, RecipientTiers.Default).pipe(
    Layer.provideMerge(registry),
  );
  return { layer: ReadService.Default.pipe(Layer.provideMerge(services)), isds };
};

type Services = Layer.Success<ReturnType<typeof servicesLayer>["layer"]>;

/** Runs `body` over freshly built services in a temp data dir; the dir is removed afterwards. */
const withServices = <A, E>(
  respond: FakeRespond,
  body: (env: {
    readonly dataDir: string;
    readonly isds: ReturnType<typeof fakeIsdsTransports>;
  }) => Effect.Effect<A, E, Services>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = join(yield* fs.makeTempDirectoryScoped({ prefix: "ds-domain-" }), "data");
    const { layer, isds } = servicesLayer(respond, dataDir);
    return yield* body({ dataDir, isds }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

const addBox = (who: { readonly username: string }) =>
  Effect.gen(function* () {
    const registry = yield* BoxRegistry;
    return yield* registry.add({
      label: who.username,
      environment: "production",
      credentials: passwordCredentials(who.username, PASSWORD(who.username)),
    });
  });

interface AuditRow {
  readonly action: string;
  readonly box_id: string | null;
  readonly outcome: string;
  readonly detail_json: string;
}

const auditRows = (action?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return action === undefined
      ? yield* sql<AuditRow>`SELECT action, box_id, outcome, detail_json FROM audit_log ORDER BY rowid`
      : yield* sql<AuditRow>`SELECT action, box_id, outcome, detail_json FROM audit_log WHERE action = ${action} ORDER BY rowid`;
  });

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("domain services over their real layers", () => {
  it.effect("audits a received-list call 'started' before the transport sees it and 'ok' after", () => {
    // The respond hook needs the built services; it reads them through this late-bound context.
    const late: { context: Context.Context<SqlClient.SqlClient> | undefined } = { context: undefined };
    const seenAtRequest: Array<ReadonlyArray<string>> = [];
    const respond = responder((_config, request) =>
      request.operation === "GetListOfReceivedMessages" && late.context !== undefined
        ? auditRows("list_received_messages").pipe(
            Effect.map((rows) => rows.map((row) => row.outcome)),
            Effect.tap((outcomes) => Effect.sync(() => seenAtRequest.push(outcomes))),
            Effect.as(ok(cannedReplies.GetListOfReceivedMessages ?? "")),
            Effect.provide(late.context),
            Effect.orDie,
          )
        : undefined,
    );
    return withServices(respond, () =>
      Effect.gen(function* () {
        late.context = Context.make(SqlClient.SqlClient, yield* SqlClient.SqlClient);
        const box = yield* addBox(ALICE);
        assert.strictEqual(box.dbId, ALICE.dbId);
        const read = yield* ReadService;
        const result = yield* read.listReceivedMessages(actor, box.id, { limit: 10 });
        assert.isAbove(result.records.length, 0);

        assert.deepStrictEqual(seenAtRequest, [["started"]]);
        const audit = yield* AuditLog;
        const page = yield* audit.list({ action: "list_received_messages" });
        assert.strictEqual(page.entries.length, 1);
        const [entry] = page.entries;
        assert.strictEqual(entry?.outcome, "ok");
        assert.strictEqual(entry?.boxId, box.id);
        assert.strictEqual(entry?.actorKind, "tool");
        assert.strictEqual(entry?.grantId, "grant_1");
        assert.deepInclude(entry?.detail as object, { limit: 10, records: result.records.length });
      }),
    );
  });

  it.effect("stores the downloaded ZFO as <dataDir>/<dbID>/<dmID>.zfo 0600 and audits hashes only", () =>
    withServices(responder(), ({ dataDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const box = yield* addBox(ALICE);
        const read = yield* ReadService;
        const message = yield* read.downloadMessage(actor, box.id, DM_ID);

        const file = join(dataDir, ALICE.dbId, `${DM_ID}.zfo`);
        assert.strictEqual(message.zfo.ref, `${ALICE.dbId}/${DM_ID}.zfo`);
        const stored = yield* fs.readFile(file);
        assert.strictEqual(sha256(stored), message.zfo.sha256);
        assert.strictEqual(stored.byteLength, message.zfo.bytes);
        assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);

        const inline = message.attachments.flatMap((attachment) => (attachment._tag === "Inline" ? [attachment] : []));
        assert.isAbove(inline.length, 0);
        const [row] = yield* auditRows("download_message");
        assert.strictEqual(row?.outcome, "ok");
        const detailJson = row?.detail_json ?? "";
        assert.deepStrictEqual(JSON.parse(detailJson), {
          dmId: DM_ID,
          attachments: message.attachments.map((attachment) => ({
            index: attachment.index,
            size: attachment.size,
            sha256: attachment.sha256,
            inline: attachment._tag === "Inline",
          })),
          zfo: message.zfo,
        });
        for (const attachment of inline) {
          assert.notInclude(detailJson, Buffer.from(attachment.content).toString("base64"));
        }
        // No audit row anywhere carries the box password.
        for (const any of yield* auditRows()) assert.notInclude(any.detail_json, PASSWORD(ALICE.username));
      }),
    ),
  );

  it.effect("redacts a registered box password that ISDS echoes in an error", () => {
    const password = PASSWORD(ALICE.username);
    const respond = responder((_config, request) =>
      request.operation === "GetListOfReceivedMessages"
        ? Effect.succeed(ok(soapResponse("GetListOfReceivedMessages", dmStatus("9999", `login ${password} refused`))))
        : undefined,
    );
    return withServices(respond, () =>
      Effect.gen(function* () {
        const box = yield* addBox(ALICE);
        const read = yield* ReadService;
        const failure = yield* Effect.flip(read.listReceivedMessages(actor, box.id, {}));
        assert.strictEqual(failure._tag, "IsdsStatusError");
        // Precondition of the probe below: the error text itself carries the password.
        assert.include(failure.message, password);

        // The read service stores tag and code only; a caller storing the text gets it redacted.
        const clients = yield* BoxClients;
        yield* Effect.flip(
          audited(
            { actor, action: "probe", boxId: box.id },
            clients.use(box.id, (client) => client.listReceivedMessagesAndDeliver({})),
            { errorDetail: (error) => ({ message: error.message }) },
          ),
        );
        const rows = yield* auditRows();
        const [listed] = rows.filter((row) => row.action === "list_received_messages");
        assert.deepInclude(JSON.parse(listed?.detail_json ?? "{}"), { error: "IsdsStatusError", code: "9999" });
        const [probe] = rows.filter((row) => row.action === "probe");
        assert.strictEqual(probe?.outcome, "error");
        const probeMessage = (JSON.parse(probe?.detail_json ?? "{}") as { readonly message?: string }).message ?? "";
        assert.include(probeMessage, "login *** refused");
        for (const row of rows) assert.notInclude(row.detail_json, password);
      }),
    );
  });

  it.effect("a removed box fails reads with BoxNotFound and loses its tiers; its audit rows stay", () =>
    withServices(responder(), () =>
      Effect.gen(function* () {
        const box = yield* addBox(ALICE);
        const read = yield* ReadService;
        const tiers = yield* RecipientTiers;
        const registry = yield* BoxRegistry;
        yield* tiers.set(box.id, "rcp1234", "full");
        yield* read.listReceivedMessages(actor, box.id, {});
        const before = (yield* auditRows()).filter((row) => row.box_id === box.id);
        assert.isAbove(before.length, 0);

        yield* registry.remove(box.id);
        const failure = yield* Effect.flip(read.listReceivedMessages(actor, box.id, {}));
        assert.strictEqual(failure._tag, "BoxNotFound");
        assert.deepStrictEqual(yield* tiers.list(box.id), []);
        assert.strictEqual(yield* tiers.tier(box.id, "rcp1234"), "none");
        const after = (yield* auditRows()).filter((row) => row.box_id === box.id);
        assert.deepStrictEqual(after.slice(0, before.length), before);
        const refused = after.at(-1);
        assert.strictEqual(refused?.outcome, "error");
        assert.deepInclude(JSON.parse(refused?.detail_json ?? "{}"), { error: "BoxNotFound" });
      }),
    ),
  );

  it.effect("serialises transport calls per box while different boxes run concurrently", () => {
    const aliceEntered = Deferred.makeUnsafe<void>();
    const aliceRelease = Deferred.makeUnsafe<void>();
    const inFlight = new Map<string, number>();
    const maxInFlight = new Map<string, number>();
    const respond = responder((config, request) => {
      if (request.operation !== "GetListOfReceivedMessages") return undefined;
      const who = loginKey(config.credentials);
      const enter = Effect.sync(() => {
        const now = (inFlight.get(who) ?? 0) + 1;
        inFlight.set(who, now);
        maxInFlight.set(who, Math.max(maxInFlight.get(who) ?? 0, now));
      });
      const leave = Effect.sync(() => inFlight.set(who, (inFlight.get(who) ?? 1) - 1));
      // Alice's calls wait for the release; Bob's answer at once.
      const hold =
        who === ALICE.username
          ? Deferred.succeed(aliceEntered, undefined).pipe(Effect.andThen(Deferred.await(aliceRelease)))
          : Effect.void;
      return enter.pipe(
        Effect.andThen(hold),
        Effect.ensuring(leave),
        Effect.as(ok(cannedReplies.GetListOfReceivedMessages ?? "")),
      );
    });
    return withServices(respond, ({ isds }) =>
      Effect.gen(function* () {
        const alice = yield* addBox(ALICE);
        const bob = yield* addBox(BOB);
        const read = yield* ReadService;
        const aliceRequests = () =>
          isds.requests.filter(
            (sent) => sent.request.operation === "GetListOfReceivedMessages" && loginKey(sent.config.credentials) === ALICE.username,
          ).length;

        const first = yield* Effect.forkChild(read.listReceivedMessages(actor, alice.id, {}));
        yield* Deferred.await(aliceEntered);
        // The contender must not yield on its operation budget between its intent and the
        // transport: with yields prevented, its fiber gives control back only at an async point.
        // That holds because SQLite (in memory) runs synchronously, Alice's client is already
        // built (cached by the first call), and the fake transport answers without a timer.
        const second = yield* Effect.forkChild(
          read.listReceivedMessages(actor, alice.id, {}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
        );

        // Bob's box is not held up by Alice's call in flight.
        const bobResult = yield* read.listReceivedMessages(actor, bob.id, {});
        assert.isAbove(bobResult.records.length, 0);

        // Wait (yielding, no timer) until Alice's second call has written its intent. Its next
        // async point is the box's permit, or, were calls on one box not serialised, the held
        // transport, which would already show its request.
        const aliceOutcomes = auditRows("list_received_messages").pipe(
          Effect.map((rows) => rows.filter((row) => row.box_id === alice.id).map((row) => row.outcome)),
          Effect.tap(() => Effect.yieldNow),
        );
        const pending = yield* aliceOutcomes.pipe(Effect.repeat({ until: (outcomes) => outcomes.length === 2, times: 1000 }));
        assert.deepStrictEqual(pending, ["started", "started"]);
        assert.strictEqual(aliceRequests(), 1);
        assert.strictEqual(inFlight.get(ALICE.username), 1);

        yield* Deferred.succeed(aliceRelease, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.strictEqual(aliceRequests(), 2);
        assert.strictEqual(maxInFlight.get(ALICE.username), 1);
        const outcomes = (yield* auditRows("list_received_messages")).map((row) => row.outcome);
        assert.deepStrictEqual(outcomes, ["ok", "ok", "ok"]);
      }),
    );
  });
});
