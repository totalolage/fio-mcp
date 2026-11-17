import { createHash } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { Redactor } from "@mcps/core/redaction.js";
import { Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import {
  AUDIT_RETENTION_DAYS,
  type AuditCursor,
  type AuditEntry,
  type AuditEventInput,
  AuditLog,
  type AuditLogShape,
  AuditRetentionFloor,
  audited,
  formatAuditCursor,
  parseAuditCursor,
} from "../../src/domain/audit-log.js";
import { DomainStoreError } from "../../src/domain/errors.js";
import { IsdsTimeoutError } from "../../src/isds/errors.js";
import { memoryDatabase } from "./support/database.js";

const SECRET = "tok-very-secret-1234";
const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const DAY = 24 * 60 * 60 * 1000;

const auditLayer = AuditLog.Default.pipe(
  Layer.provideMerge(Layer.mergeAll(memoryDatabase(), Redactor.layer(Effect.succeed([SECRET])))),
);

const tool = (grantId: string, action: string, boxId?: string): AuditEventInput => ({
  actor: { kind: "tool", grantId, clientId: "client-1" },
  action,
  boxId,
});

const storedDetail = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ detail_json: string }>`SELECT detail_json FROM audit_log WHERE id = ${id}`;
    return rows[0]?.detail_json;
  });

const entryOf = (id: string) =>
  Effect.gen(function* () {
    const audit = yield* AuditLog;
    const page = yield* audit.list({ limit: 500 });
    const entry = page.entries.find((candidate) => candidate.id === id);
    assert.isDefined(entry);
    return entry as AuditEntry;
  });

/** Every page of `query` from the newest on, following `next`. */
const allPages = (query: { limit: number; grantId?: string; boxId?: string; action?: string }) =>
  Effect.gen(function* () {
    const audit = yield* AuditLog;
    const pages: Array<ReadonlyArray<AuditEntry>> = [];
    let before: AuditCursor | undefined;
    for (;;) {
      const page = yield* audit.list({ ...query, before });
      pages.push(page.entries);
      if (page.next === undefined) return pages;
      before = page.next;
    }
  });

/** Newest first per the list order: at DESC, id DESC. */
const newestFirst = (entries: ReadonlyArray<AuditEntry>) =>
  [...entries]
    .sort((a, b) => {
      if (a.at !== b.at) return b.at - a.at;
      if (a.id === b.id) return 0;
      // SQLite compares TEXT bytewise; ids are ASCII, so code-unit order matches.
      return a.id < b.id ? 1 : -1;
    })
    .map((entry) => entry.id);

/** The Date purgeBefore takes (outside Effect code: the contract's input type). */
const dateAt = (millis: number): Date => new Date(millis);

describe("AuditLog", () => {
  it.effect("start writes a started entry that finish completes with its outcome and detail", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      yield* TestClock.adjust(1000);
      const id = yield* audit.start({ ...tool("g1", "list_received_messages", "box_a"), detail: { phase: "intent" } });
      const started = yield* entryOf(id);
      assert.deepStrictEqual(
        { outcome: started.outcome, at: started.at, updatedAt: started.updatedAt, detail: started.detail },
        { outcome: "started", at: 1000, updatedAt: 1000, detail: { phase: "intent" } },
      );
      assert.strictEqual(started.actorKind, "tool");
      assert.strictEqual(started.grantId, "g1");
      assert.strictEqual(started.clientId, "client-1");
      assert.strictEqual(started.subject, undefined);
      assert.strictEqual(started.boxId, "box_a");

      yield* TestClock.adjust(500);
      yield* audit.finish(id, "ok", { count: 3 });
      const finished = yield* entryOf(id);
      assert.deepStrictEqual(
        { outcome: finished.outcome, at: finished.at, updatedAt: finished.updatedAt, detail: finished.detail },
        { outcome: "ok", at: 1000, updatedAt: 1500, detail: { count: 3 } },
      );
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("finish without detail keeps the start detail", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const id = yield* audit.start({ ...tool("g1", "send_message"), detail: { kept: true } });
      yield* audit.finish(id, "error");
      const entry = yield* entryOf(id);
      assert.strictEqual(entry.outcome, "error");
      assert.deepStrictEqual(entry.detail, { kept: true });
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("finish leaves a finished entry alone and ignores an unknown id", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const id = yield* audit.start(tool("g1", "send_message"));
      yield* audit.finish(id, "ok", { first: true });
      yield* audit.finish(id, "error", { second: true });
      const entry = yield* entryOf(id);
      assert.strictEqual(entry.outcome, "ok");
      assert.deepStrictEqual(entry.detail, { first: true });
      yield* audit.finish("aud_missing", "ok");
      const page = yield* audit.list();
      assert.strictEqual(page.entries.length, 1);
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("record writes a one-shot entry with its final outcome and {} for no detail", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const id = yield* audit.record({ actor: { kind: "admin", subject: "admin@example" }, action: "box.add", outcome: "refused" });
      const entry = yield* entryOf(id);
      assert.strictEqual(entry.outcome, "refused");
      assert.strictEqual(entry.actorKind, "admin");
      assert.strictEqual(entry.subject, "admin@example");
      assert.strictEqual(entry.grantId, undefined);
      assert.deepStrictEqual(entry.detail, {});
      assert.isTrue(entry.id.startsWith("aud_"));
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("stores detail redacted, with byte arrays as {bytes, sha256}", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const attachment = new Uint8Array([1, 2, 3, 250, 251, 252]);
      const buffer = Buffer.from("zfo-content");
      const id = yield* audit.record({
        ...tool("g1", "download_message"),
        outcome: "ok",
        detail: {
          token: `Bearer ${SECRET}`,
          nested: [{ file: attachment }],
          zfo: buffer,
          note: "plain",
          skipped: undefined,
        },
      });
      const json = yield* storedDetail(id);
      assert.isDefined(json);
      assert.notInclude(json as string, SECRET);
      assert.notInclude(json as string, '"0":');
      assert.notInclude(json as string, "zfo-content");
      assert.notInclude(json as string, Buffer.from("zfo-content").toString("base64"));
      assert.deepStrictEqual((yield* entryOf(id)).detail, {
        token: "Bearer ***",
        nested: [{ file: { bytes: 6, sha256: sha(attachment) } }],
        zfo: { bytes: buffer.byteLength, sha256: sha(buffer) },
        note: "plain",
      });
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("redacts the detail finish stores", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const id = yield* audit.start(tool("g1", "send_message"));
      yield* audit.finish(id, "ok", { echoed: SECRET, body: new Uint8Array(4) });
      const json = (yield* storedDetail(id)) as string;
      assert.notInclude(json, SECRET);
      assert.deepStrictEqual((yield* entryOf(id)).detail, {
        echoed: "***",
        body: { bytes: 4, sha256: createHash("sha256").update(new Uint8Array(4)).digest("hex") },
      });
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("walks class instances, so their bytes are summarized and their secrets redacted", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      class Upload {
        readonly name = `report-${SECRET}.pdf`;
        readonly content = bytesOf("attachment-content");
        describe() {
          return this.name;
        }
      }
      const id = yield* audit.record({ ...tool("g1", "x"), outcome: "ok", detail: { upload: new Upload() } });
      const json = (yield* storedDetail(id)) as string;
      assert.notInclude(json, SECRET);
      assert.notInclude(json, "attachment-content");
      assert.deepStrictEqual((yield* entryOf(id)).detail, {
        upload: { name: "report-***.pdf", content: { bytes: 18, sha256: sha(bytesOf("attachment-content")) } },
      });
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("runs toJSON hooks before redacting, so their output is redacted too", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const hooked = { toJSON: () => ({ leaked: SECRET, raw: bytesOf("hook-bytes") }) };
      const id = yield* audit.record({
        ...tool("g1", "x"),
        outcome: "ok",
        detail: { hooked, when: dateAt(0), list: [undefined, () => 1, Number.NaN] },
      });
      const json = (yield* storedDetail(id)) as string;
      assert.notInclude(json, SECRET);
      assert.notInclude(json, "hook-bytes");
      assert.deepStrictEqual((yield* entryOf(id)).detail, {
        hooked: { leaked: "***", raw: { bytes: 10, sha256: sha(bytesOf("hook-bytes")) } },
        when: "1970-01-01T00:00:00.000Z",
        list: [null, null, null],
      });
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("keeps null and bigint values, and marks a circular reference", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const nullId = yield* audit.record({ ...tool("g1", "x"), outcome: "ok", detail: null });
      assert.strictEqual((yield* entryOf(nullId)).detail, null);
      const loop: Record<string, unknown> = { n: 12_345_678_901_234_567_890n };
      loop.self = loop;
      const loopId = yield* audit.record({ ...tool("g1", "x"), outcome: "ok", detail: loop });
      assert.deepStrictEqual((yield* entryOf(loopId)).detail, { n: "12345678901234567890", self: "[circular]" });
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("writes the entry with an unencodable marker when the detail throws while encoding", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const exploding = {
        get value(): string {
          throw new Error(`getter failed ${SECRET}`);
        },
      };
      const id = yield* audit.start({ ...tool("g1", "x"), detail: exploding });
      assert.deepStrictEqual((yield* entryOf(id)).detail, { detailError: "unencodable" });

      // finish with an unencodable detail still records the outcome and keeps the stored detail.
      const okId = yield* audit.start({ ...tool("g1", "x"), detail: { kept: 1 } });
      yield* audit.finish(okId, "ok", exploding);
      const finished = yield* entryOf(okId);
      assert.strictEqual(finished.outcome, "ok");
      assert.deepStrictEqual(finished.detail, { kept: 1 });
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("pages newest first, breaking equal timestamps by id, until next is absent", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      // Five entries at t=0 and four at t=10: the cursor has to tie-break by id.
      for (let i = 0; i < 5; i++) yield* audit.record({ ...tool("g1", "a"), outcome: "ok" });
      yield* TestClock.adjust(10);
      for (let i = 0; i < 4; i++) yield* audit.record({ ...tool("g1", "a"), outcome: "ok" });
      const all = (yield* audit.list()).entries;
      assert.strictEqual(all.length, 9);
      assert.deepStrictEqual(
        all.map((entry) => entry.id),
        newestFirst(all),
      );

      const pages = yield* allPages({ limit: 2 });
      assert.deepStrictEqual(
        pages.map((page) => page.length),
        [2, 2, 2, 2, 1],
      );
      assert.deepStrictEqual(pages.flat().map((entry) => entry.id), newestFirst(all));

      // A page that ends exactly at the last entry has no next.
      const threes = yield* allPages({ limit: 3 });
      assert.deepStrictEqual(
        threes.map((page) => page.length),
        [3, 3, 3],
      );
      const last = yield* audit.list({ limit: 500 });
      assert.strictEqual(last.next, undefined);
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("filters by grant, box and action, combined, across pages", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const inputs = [
        tool("g1", "list", "box_a"),
        tool("g1", "send", "box_a"),
        tool("g2", "list", "box_a"),
        tool("g1", "list", "box_b"),
        tool("g1", "list", "box_a"),
        tool("g1", "list", "box_a"),
      ];
      for (const input of inputs) yield* audit.record({ ...input, outcome: "ok" });

      const match = (query: { grantId?: string; boxId?: string; action?: string }) =>
        Effect.map(allPages({ ...query, limit: 1 }), (pages) => pages.flat());
      const g1 = yield* match({ grantId: "g1" });
      assert.strictEqual(g1.length, 5);
      assert.isTrue(g1.every((entry) => entry.grantId === "g1"));
      assert.strictEqual((yield* match({ boxId: "box_b" })).length, 1);
      assert.strictEqual((yield* match({ action: "send" })).length, 1);
      const combined = yield* match({ grantId: "g1", boxId: "box_a", action: "list" });
      assert.strictEqual(combined.length, 3);
      assert.deepStrictEqual(
        combined.map((entry) => entry.id),
        newestFirst(combined),
      );
      assert.isTrue(combined.every((e) => e.grantId === "g1" && e.boxId === "box_a" && e.action === "list"));
      assert.strictEqual((yield* match({ grantId: "g3" })).length, 0);
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("clamps the page size to 1..500 and defaults to 100", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      for (let i = 0; i < 501; i++) yield* audit.record({ ...tool("g1", "a"), outcome: "ok" });
      const byDefault = yield* audit.list();
      assert.strictEqual(byDefault.entries.length, 100);
      assert.isDefined(byDefault.next);
      assert.strictEqual((yield* audit.list({ limit: 0 })).entries.length, 1);
      assert.strictEqual((yield* audit.list({ limit: -5 })).entries.length, 1);
      assert.strictEqual((yield* audit.list({ limit: 2.9 })).entries.length, 2);
      const capped = yield* audit.list({ limit: 10_000 });
      assert.strictEqual(capped.entries.length, 500);
      assert.isDefined(capped.next);
      const rest = yield* audit.list({ limit: 500, before: capped.next });
      assert.strictEqual(rest.entries.length, 1);
      assert.strictEqual(rest.next, undefined);
    }).pipe(Effect.provide(auditLayer)),
  );

  it.effect("purgeBefore refuses a cutoff inside the retention floor and deletes only older entries", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const at = (days: number) => TestClock.setTime(days * DAY);
      yield* at(0);
      const day0 = yield* audit.record({ ...tool("g1", "a"), outcome: "ok" });
      yield* at(10);
      const day10 = yield* audit.start(tool("g1", "a"));
      yield* at(35);
      const day35 = yield* audit.record({ ...tool("g1", "a"), outcome: "ok" });
      yield* at(100);
      const day100 = yield* audit.record({ ...tool("g1", "a"), outcome: "ok" });
      yield* at(35 + AUDIT_RETENTION_DAYS);
      const floor = 35 * DAY;

      const refused = yield* Effect.flip(audit.purgeBefore(dateAt(floor + 1)));
      assert.instanceOf(refused, AuditRetentionFloor);
      assert.strictEqual((refused as AuditRetentionFloor).earliestAllowed, "1970-02-05");
      const invalid = yield* Effect.flip(audit.purgeBefore(dateAt(Number.NaN)));
      assert.instanceOf(invalid, AuditRetentionFloor);
      assert.strictEqual((yield* audit.list()).entries.length, 4);

      // The floor itself is allowed; the entry written exactly at the cutoff stays.
      assert.strictEqual(yield* audit.purgeBefore(dateAt(floor)), 2);
      const left = (yield* audit.list()).entries.map((entry) => entry.id);
      assert.deepStrictEqual(left, [day100, day35]);
      assert.notInclude(left, day0);
      assert.notInclude(left, day10);
      assert.strictEqual(yield* audit.purgeBefore(dateAt(floor)), 0);
    }).pipe(Effect.provide(auditLayer)),
  );
});

describe("audit cursors", () => {
  it("round-trip through formatAuditCursor", () => {
    const cursor = { at: 1_700_000_000_000, id: "aud_a.b-c_d" };
    assert.deepStrictEqual(parseAuditCursor(formatAuditCursor(cursor)), cursor);
  });

  it("reject malformed text", () => {
    for (const text of ["", ".", "123", "123.", ".aud_x", "abc.aud_x", "-1.aud_x", "1e400.aud_x", "9007199254740993.aud_x"]) {
      assert.isUndefined(parseAuditCursor(text), text);
    }
  });

  it("keep dots after the first as part of the id", () => {
    assert.deepStrictEqual(parseAuditCursor("1.5.aud"), { at: 1, id: "5.aud" });
  });
});

/** An AuditLog that records calls; `failStart` makes start fail. */
const fakeAudit = (calls: Ref.Ref<ReadonlyArray<string>>, failStart = false) =>
  Layer.succeed(
    AuditLog,
    AuditLog.of({
      start: (input) =>
        failStart
          ? Effect.fail(new DomainStoreError({ operation: "write an audit entry" }))
          : Effect.as(Ref.update(calls, (all) => [...all, `start:${input.action}`]), "aud_1"),
      finish: (id, outcome, detail) =>
        Ref.update(calls, (all) => [...all, `finish:${id}:${outcome}:${JSON.stringify(detail ?? null)}`]),
      record: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      purgeBefore: () => Effect.die("unused"),
    } satisfies AuditLogShape),
  );

describe("audited", () => {
  const input = tool("g1", "send_message", "box_a");

  it.effect("does not run the effect when the intent cannot be written", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const ran = yield* Ref.make(false);
      const error = yield* Effect.flip(audited(input, Ref.set(ran, true))).pipe(
        Effect.provide(fakeAudit(calls, true)),
      );
      assert.instanceOf(error, DomainStoreError);
      assert.isFalse(yield* Ref.get(ran));
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }),
  );

  it.effect("records ok with the success detail and returns the value", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const value = yield* audited(
        input,
        Effect.tap(Effect.succeed(7), () => Ref.update(calls, (all) => [...all, "run"])),
        { okDetail: (n) => ({ n }) },
      ).pipe(Effect.provide(fakeAudit(calls)));
      assert.strictEqual(value, 7);
      assert.deepStrictEqual(yield* Ref.get(calls), ["start:send_message", "run", 'finish:aud_1:ok:{"n":7}']);
    }),
  );

  it.effect("records error with the failure detail and passes the error on", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const error = yield* Effect.flip(
        audited(input, Effect.fail({ _tag: "IsdsStatusError" as const, code: "1216" }), {
          errorDetail: (e) => ({ code: e.code }),
        }),
      ).pipe(Effect.provide(fakeAudit(calls)));
      assert.strictEqual(error._tag, "IsdsStatusError");
      assert.deepStrictEqual(yield* Ref.get(calls), ["start:send_message", 'finish:aud_1:error:{"code":"1216"}']);
    }),
  );

  it.effect("records uncertain for a timeout after the request was sent, error before", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const timeout = (requestSent: boolean) =>
        new IsdsTimeoutError({ service: "operations", operation: "CreateMessage", timeoutMillis: 60_000, requestSent });
      const layer = fakeAudit(calls);
      yield* Effect.flip(audited(input, Effect.fail(timeout(true)))).pipe(Effect.provide(layer));
      yield* Effect.flip(audited(input, Effect.fail(timeout(false)))).pipe(Effect.provide(layer));
      assert.deepStrictEqual(yield* Ref.get(calls), [
        "start:send_message",
        "finish:aud_1:uncertain:null",
        "start:send_message",
        "finish:aud_1:error:null",
      ]);
    }),
  );

  it.effect("uses classify when given, and records a defect as error and an interruption as uncertain", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = fakeAudit(calls);
      yield* Effect.flip(audited(input, Effect.fail("nope"), { classify: () => "refused" })).pipe(Effect.provide(layer));
      yield* Effect.exit(audited(input, Effect.die("boom"))).pipe(Effect.provide(layer));
      yield* Effect.exit(audited(input, Effect.interrupt)).pipe(Effect.provide(layer));
      assert.deepStrictEqual(yield* Ref.get(calls), [
        "start:send_message",
        "finish:aud_1:refused:null",
        "start:send_message",
        "finish:aud_1:error:null",
        "start:send_message",
        "finish:aud_1:uncertain:null",
      ]);
    }),
  );

  it.effect("records the outcome without detail when a mapper throws, and uncertain when classify throws", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = fakeAudit(calls);
      const value = yield* audited(input, Effect.succeed("sent"), {
        okDetail: () => {
          throw new Error("mapper bug");
        },
      }).pipe(Effect.provide(layer));
      assert.strictEqual(value, "sent");
      const error = yield* Effect.flip(
        audited(input, Effect.fail("nope"), {
          classify: () => {
            throw new Error("classify bug");
          },
          errorDetail: () => {
            throw new Error("detail bug");
          },
        }),
      ).pipe(Effect.provide(layer));
      assert.strictEqual(error, "nope");
      assert.deepStrictEqual(yield* Ref.get(calls), [
        "start:send_message",
        "finish:aud_1:ok:null",
        "start:send_message",
        "finish:aud_1:uncertain:null",
      ]);
    }),
  );

  it.effect("keeps the call's result when the outcome cannot be recorded, against the real log", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const result = yield* audited(
        input,
        // The table disappears mid-call, so finish fails.
        Effect.as(sql`ALTER TABLE audit_log RENAME TO audit_log_gone`, "sent"),
      );
      assert.strictEqual(result, "sent");
      const rows = yield* sql<{ outcome: string }>`SELECT outcome FROM audit_log_gone`;
      assert.deepStrictEqual(
        rows.map((row) => row.outcome),
        ["started"],
      );
    }).pipe(Effect.provide(auditLayer)),
  );
});
