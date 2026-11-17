import { assert, describe, it } from "@effect/vitest";
import type { AdminActionContext, AdminTab } from "@mcps/core/admin/tab.js";
import { makeRedactor, Redactor } from "@mcps/core/redaction.js";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { RECIPIENTS_PATH, recipientsTab } from "../../src/admin/recipients-tab.js";
import { AuditLog } from "../../src/domain/audit-log.js";
import { DomainStoreError } from "../../src/domain/errors.js";
import { RecipientTiers } from "../../src/domain/recipient-tiers.js";
import { memoryDatabase } from "../domain/support/database.js";
import { fakeBox, makeFakeBoxRegistry } from "../domain/support/fake-box-registry.js";
import { passwordCredentials } from "../domain/support/fake-isds.js";
import { type ReadReply, readBoxClients } from "../domain/support/read-box-clients.js";
import { fixture, ok } from "../isds/fake-transport.js";

const BOX = "box_AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_BOX = "box_BBBBBBBBBBBBBBBBBBBBBB";
const RECIPIENT = "xyz9876";

const ACTIVE = ok(fixture("CheckDataBox.xml"));
const NOT_FOUND = ok(fixture("CheckDataBox-not-found.xml"));
const INACTIVE = ok(fixture("CheckDataBox.xml").replace("<p:dbState>1</p:dbState>", "<p:dbState>3</p:dbState>"));

const CONTEXT: AdminActionContext = { checkSecondFactor: Effect.succeed({ _tag: "Accepted", value: undefined }), files: [] };

const insertBox = (id: string, dbId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO boxes (id, db_id, label, label_key, environment, auth_kind, owner_json, credentials_sealed,
        created_at, updated_at)
      VALUES (${id}, ${dbId}, ${id}, ${id}, 'test', 'password', '{}', 'sealed', 0, 0)
    `;
  });

interface AuditFaults {
  failStart: boolean;
  failFinish: boolean;
}

/** The real AuditLog, except that start / finish fail while `faults` says so. */
const faultyAuditLog = (faults: AuditFaults) =>
  Layer.effect(
    AuditLog,
    Effect.gen(function* () {
      const real = yield* AuditLog;
      return AuditLog.of({
        ...real,
        start: (input) =>
          faults.failStart ? Effect.fail(new DomainStoreError({ operation: "write audit entry" })) : real.start(input),
        finish: (id, outcome, detail) =>
          faults.failFinish
            ? Effect.fail(new DomainStoreError({ operation: "update audit entry" }))
            : real.finish(id, outcome, detail),
      });
    }),
  ).pipe(Layer.provide(AuditLog.Default));

/**
 * The tab over a migrated in-memory database (real RecipientTiers and AuditLog), a fake
 * registry with two boxes (the first labelled with markup) and BoxClients over the fake ISDS
 * transport for the first box, answering CheckDataBox with `reply.current`. `faults` makes
 * the AuditLog's start or finish fail.
 */
const withTab = <A, E>(
  body: (harness: {
    readonly tab: AdminTab;
    readonly log: Array<string>;
    readonly reply: { current: ReadReply };
    readonly faults: AuditFaults;
  }) => Effect.Effect<A, E, RecipientTiers | AuditLog | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const log: Array<string> = [];
    const reply: { current: ReadReply } = { current: ACTIVE };
    const clients = readBoxClients(BOX, { CheckDataBox: (request) => {
      const current = reply.current;
      return typeof current === "function" ? current(request) : Effect.succeed(current);
    } }, log);
    const registry = yield* makeFakeBoxRegistry([
      { box: { ...fakeBox(BOX, "aaa1111"), label: "Office <b>&</b>" }, credentials: passwordCredentials("alice") },
      { box: { ...fakeBox(OTHER_BOX, "bbb2222"), label: "Home" }, credentials: passwordCredentials("bob") },
    ]);
    const faults: AuditFaults = { failStart: false, failFinish: false };
    const services = Layer.mergeAll(RecipientTiers.Default, faultyAuditLog(faults)).pipe(
      Layer.provide(Layer.succeed(Redactor, makeRedactor([]))),
      Layer.provideMerge(memoryDatabase()),
    );
    return yield* Effect.gen(function* () {
      yield* insertBox(BOX, "aaa1111");
      yield* insertBox(OTHER_BOX, "bbb2222");
      const tab = yield* recipientsTab;
      return yield* body({ tab, log, reply, faults });
    }).pipe(Effect.provide(Layer.mergeAll(services, registry.layer, clients.layer)));
  });

const act = (tab: AdminTab, path: string, form: Record<string, string>) => {
  const action = tab.actions.find((candidate) => candidate.path === path);
  return action === undefined ? Effect.die(`no action ${path}`) : action.run(new URLSearchParams(form), CONTEXT);
};

const audits = Effect.gen(function* () {
  const page = yield* (yield* AuditLog).list();
  return page.entries.toReversed().map((entry) => ({
    action: entry.action,
    outcome: entry.outcome,
    actorKind: entry.actorKind,
    boxId: entry.boxId,
    detail: entry.detail,
  }));
});

const listed = (boxId: string) =>
  Effect.flatMap(RecipientTiers, (tiers) => tiers.list(boxId)).pipe(
    Effect.map((entries) => entries.map(({ recipientDbId, tier, note }) => ({ recipientDbId, tier, note }))),
  );

describe("recipients tab", () => {
  it.effect("sits at /admin/recipients", () =>
    withTab(({ tab }) =>
      Effect.sync(() => {
        assert.strictEqual(tab.id, "recipients");
        assert.strictEqual(tab.label, "Recipients");
        assert.strictEqual(tab.path, RECIPIENTS_PATH);
        assert.strictEqual(RECIPIENTS_PATH, "/admin/recipients");
      }),
    ),
  );

  it.effect("renders each box with its recipients, escaping labels and notes", () =>
    withTab(({ tab }) =>
      Effect.gen(function* () {
        const tiers = yield* RecipientTiers;
        yield* tiers.set(BOX, RECIPIENT, "approve", `Tax office <script>alert("x")</script>`);
        yield* tiers.set(OTHER_BOX, "qqq1234", "full");
        const view = yield* tab.render("csrf-token", { query: new URLSearchParams(), secondFactor: false });
        const html = view.body;
        assert.isUndefined(view.error);
        assert.include(html, "Office &lt;b&gt;&amp;&lt;/b&gt;");
        assert.notInclude(html, "<b>&</b>");
        assert.include(html, "aaa1111");
        assert.include(html, RECIPIENT);
        assert.include(html, "Tax office &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
        assert.notInclude(html, "<script>");
        assert.include(html, "qqq1234");
        assert.include(html, `name="csrf" value="csrf-token"`);
        for (const path of ["/admin/recipients/add", "/admin/recipients/edit", "/admin/recipients/remove"]) {
          assert.include(html, `action="${path}"`);
        }
        assert.include(html, `value="approve" selected`);
      }),
    ),
  );

  it.effect("adds a recipient after CheckDataBox reports it active, and audits it", () =>
    withTab(({ tab, log }) =>
      Effect.gen(function* () {
        const flash = yield* act(tab, "/admin/recipients/add", {
          box: BOX,
          recipient: ` ${RECIPIENT.toUpperCase()} `,
          tier: "full",
          note: "Supplier",
        });
        assert.strictEqual(flash.kind, "ok");
        assert.include(flash.text, RECIPIENT);
        assert.include(flash.text, "full");
        assert.deepStrictEqual(log, ["isds CheckDataBox"]);
        assert.deepStrictEqual(yield* listed(BOX), [{ recipientDbId: RECIPIENT, tier: "full", note: "Supplier" }]);
        assert.deepStrictEqual(yield* audits, [
          {
            action: "recipient.set",
            outcome: "ok",
            actorKind: "admin",
            boxId: BOX,
            detail: { recipient: RECIPIENT, tier: "full", note: "Supplier", dbState: 1 },
          },
        ]);
      }),
    ),
  );

  it.effect("refuses a recipient ISDS does not know, saving nothing", () =>
    withTab(({ tab, reply }) =>
      Effect.gen(function* () {
        reply.current = NOT_FOUND;
        const flash = yield* act(tab, "/admin/recipients/add", { box: BOX, recipient: RECIPIENT, tier: "approve" });
        assert.strictEqual(flash.kind, "error");
        assert.include(flash.text, `no data box ${RECIPIENT}`);
        assert.include(flash.text, "Nothing was saved");
        assert.deepStrictEqual(yield* listed(BOX), []);
        const [row] = yield* audits;
        assert.deepInclude(row, { action: "recipient.set", outcome: "refused", actorKind: "admin", boxId: BOX });
      }),
    ),
  );

  it.effect("saves an inactive recipient and says which state ISDS reports", () =>
    withTab(({ tab, reply }) =>
      Effect.gen(function* () {
        reply.current = INACTIVE;
        const flash = yield* act(tab, "/admin/recipients/add", { box: BOX, recipient: RECIPIENT, tier: "approve" });
        assert.strictEqual(flash.kind, "ok");
        assert.include(flash.text, "state 3");
        assert.include(flash.text, "refused");
        assert.deepStrictEqual(yield* listed(BOX), [{ recipientDbId: RECIPIENT, tier: "approve", note: undefined }]);
        const [row] = yield* audits;
        assert.deepInclude(row, { action: "recipient.set", outcome: "ok", boxId: BOX });
        assert.deepInclude(row?.detail as object, { dbState: 3 });
      }),
    ),
  );

  it.effect("saves nothing when ISDS gives no usable answer, and audits an error", () =>
    withTab(({ tab, reply }) =>
      Effect.gen(function* () {
        reply.current = ok("");
        const flash = yield* act(tab, "/admin/recipients/add", { box: BOX, recipient: RECIPIENT, tier: "approve" });
        assert.strictEqual(flash.kind, "error");
        assert.include(flash.text, "could not be checked");
        assert.deepStrictEqual(yield* listed(BOX), []);
        const [row] = yield* audits;
        assert.deepInclude(row, { action: "recipient.set", outcome: "error", boxId: BOX });
      }),
    ),
  );

  it.effect("refuses malformed input without calling ISDS, auditing each refusal", () =>
    withTab(({ tab, log }) =>
      Effect.gen(function* () {
        const forms: ReadonlyArray<Record<string, string>> = [
          { box: BOX, recipient: "abc", tier: "approve" },
          { box: BOX, recipient: RECIPIENT, tier: "none" },
          { box: BOX, recipient: RECIPIENT, tier: "everything" },
          { box: "box_CCCCCCCCCCCCCCCCCCCCCC", recipient: RECIPIENT, tier: "approve" },
          { box: "not a box", recipient: RECIPIENT, tier: "approve" },
        ];
        for (const form of forms) {
          const flash = yield* act(tab, "/admin/recipients/add", form);
          assert.strictEqual(flash.kind, "error", JSON.stringify(form));
        }
        assert.deepStrictEqual(log, []);
        assert.deepStrictEqual(yield* listed(BOX), []);
        const rows = yield* audits;
        // Rows written in the same millisecond have no defined order, so compare them sorted.
        assert.deepStrictEqual(
          rows.map((row) => `${row.action} ${row.outcome} ${row.boxId ?? "-"}`).toSorted(),
          [
            "recipient.set refused -",
            `recipient.set refused ${BOX}`,
            `recipient.set refused ${BOX}`,
            `recipient.set refused ${BOX}`,
            "recipient.set refused box_CCCCCCCCCCCCCCCCCCCCCC",
          ],
        );
      }),
    ),
  );

  it.effect("edits a listed recipient's tier and note without calling ISDS", () =>
    withTab(({ tab, log }) =>
      Effect.gen(function* () {
        yield* (yield* RecipientTiers).set(BOX, RECIPIENT, "approve", "old");
        const flash = yield* act(tab, "/admin/recipients/edit", { box: BOX, recipient: RECIPIENT, tier: "full", note: "new" });
        assert.strictEqual(flash.kind, "ok");
        assert.deepStrictEqual(log, []);
        assert.deepStrictEqual(yield* listed(BOX), [{ recipientDbId: RECIPIENT, tier: "full", note: "new" }]);
        assert.deepStrictEqual(yield* audits, [
          {
            action: "recipient.set",
            outcome: "ok",
            actorKind: "admin",
            boxId: BOX,
            detail: { recipient: RECIPIENT, tier: "full", note: "new" },
          },
        ]);
      }),
    ),
  );

  it.effect("edit refuses an unlisted recipient; tier none removes a listed one", () =>
    withTab(({ tab }) =>
      Effect.gen(function* () {
        const unlisted = yield* act(tab, "/admin/recipients/edit", { box: BOX, recipient: RECIPIENT, tier: "full" });
        assert.strictEqual(unlisted.kind, "error");
        assert.include(unlisted.text, "not listed");
        yield* (yield* RecipientTiers).set(BOX, RECIPIENT, "approve");
        const removed = yield* act(tab, "/admin/recipients/edit", { box: BOX, recipient: RECIPIENT, tier: "none" });
        assert.strictEqual(removed.kind, "ok");
        assert.deepStrictEqual(yield* listed(BOX), []);
        assert.deepStrictEqual(
          (yield* audits).map((row) => `${row.action} ${row.outcome}`).toSorted(),
          ["recipient.remove ok", "recipient.set refused"],
        );
      }),
    ),
  );

  it.effect("removes a recipient and audits it", () =>
    withTab(({ tab, log }) =>
      Effect.gen(function* () {
        yield* (yield* RecipientTiers).set(BOX, RECIPIENT, "full");
        const flash = yield* act(tab, "/admin/recipients/remove", { box: BOX, recipient: RECIPIENT });
        assert.strictEqual(flash.kind, "ok");
        assert.include(flash.text, "none");
        assert.deepStrictEqual(log, []);
        assert.deepStrictEqual(yield* listed(BOX), []);
        assert.deepStrictEqual(yield* audits, [
          {
            action: "recipient.remove",
            outcome: "ok",
            actorKind: "admin",
            boxId: BOX,
            detail: { recipient: RECIPIENT },
          },
        ]);
      }),
    ),
  );

  it.effect("saves nothing when the audit intent cannot be written", () =>
    withTab(({ tab, log, faults }) =>
      Effect.gen(function* () {
        faults.failStart = true;
        const flash = yield* act(tab, "/admin/recipients/add", { box: BOX, recipient: RECIPIENT, tier: "full" });
        assert.strictEqual(flash.kind, "error");
        assert.include(flash.text, "audit entry could not be written");
        assert.deepStrictEqual(log, []);
        assert.deepStrictEqual(yield* listed(BOX), []);
        assert.deepStrictEqual(yield* audits, []);
      }),
    ),
  );

  it.effect("keeps the started audit row when its outcome cannot be written", () =>
    withTab(({ tab, faults }) =>
      Effect.gen(function* () {
        faults.failFinish = true;
        const flash = yield* act(tab, "/admin/recipients/add", { box: BOX, recipient: RECIPIENT, tier: "full" });
        assert.strictEqual(flash.kind, "ok");
        assert.include(flash.text, "audit entry could not be completed");
        assert.deepStrictEqual(yield* listed(BOX), [{ recipientDbId: RECIPIENT, tier: "full", note: undefined }]);
        assert.deepStrictEqual(yield* audits, [
          {
            action: "recipient.set",
            outcome: "started",
            actorKind: "admin",
            boxId: BOX,
            detail: { recipient: RECIPIENT, tier: "full" },
          },
        ]);
      }),
    ),
  );

  it.effect("an add interrupted during CheckDataBox saves nothing and finishes its audit row as an error", () =>
    withTab(({ tab, reply }) =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        reply.current = () => Effect.andThen(Deferred.succeed(reached, undefined), Effect.never);
        const fiber = yield* Effect.forkChild(
          act(tab, "/admin/recipients/add", { box: BOX, recipient: RECIPIENT, tier: "full" }),
        );
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(fiber);
        assert.deepStrictEqual(yield* listed(BOX), []);
        const [row] = yield* audits;
        assert.deepInclude(row, { action: "recipient.set", outcome: "error", boxId: BOX });
        assert.deepInclude(row?.detail as object, { error: "interrupted" });
      }),
    ),
  );
});
