import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Sink, Stdio } from "effect";
import { TestClock } from "effect/testing";
import { Accounts } from "../src/accounts.js";
import { SERVER_MIGRATIONS } from "../src/cache/db.js";
import { FioApi } from "../src/fio-api.js";
import { parsePurgeArgs, purgePaymentsCommand } from "../src/payment-cli.js";
import { AUDIT_RETENTION_DAYS, PaymentControls } from "../src/payment-controls.js";
import { type NewAuditRow, PaymentLedger } from "../src/payment-ledger.js";
import { RedactorDefault } from "../src/redaction.js";
import { seededConfig } from "./support/config.js";
import { memoryDatabase } from "./support/database.js";
import { testConfig } from "./support/transport.js";

const DAY = 24 * 60 * 60 * 1000;

const out: Array<string> = [];
const decoder = new TextDecoder();
const append = (chunk: string | Uint8Array) =>
  Effect.sync(() => {
    out.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
  });
const collect = Sink.forEach(append);

const testLayer = Layer.mergeAll(
  PaymentControls.Default.pipe(
    Layer.provideMerge(PaymentLedger.Default),
    Layer.provideMerge(
      Layer.mergeAll(Layer.mock(FioApi, {}), Accounts.Default, RedactorDefault, memoryDatabase(SERVER_MIGRATIONS)),
    ),
    Layer.provideMerge(seededConfig(testConfig())),
  ),
  Stdio.layerTest({ stdout: () => collect, stderr: () => collect }),
);

const row = (createdAt: number): NewAuditRow => ({
  createdAt,
  grantId: "fio_grant_1",
  clientId: null,
  accountId: null,
  accountName: "main",
  idempotencyKey: null,
  keyOwner: false,
  xmlSha256: null,
  orderCount: 1,
  totals: { CZK: 100 },
  payees: [],
  outcome: "refused",
  batchIds: [],
  fioErrorCode: null,
  reason: "limit: test",
  responseJson: null,
});

describe("fio-mcp payments purge", () => {
  it("accepts exactly `purge --before <real date>`", () => {
    assert.strictEqual(parsePurgeArgs(["purge", "--before", "2025-01-31"]), "2025-01-31");
    for (const bad of [
      [],
      ["purge"],
      ["purge", "--before"],
      ["purge", "2025-01-31"],
      ["purge", "--after", "2025-01-31"],
      ["purge", "--before", "2025-01-31", "extra"],
      ["prune", "--before", "2025-01-31"],
      ["purge", "--before", "2025-1-31"],
      ["purge", "--before", "2025-02-30"],
      ["purge", "--before", "2025-13-01"],
      ["purge", "--before", "yesterday"],
    ]) {
      assert.isUndefined(parsePurgeArgs(bad), bad.join(" "));
    }
  });

  it.effect("deletes rows of days before the cut-off and prints the count", () =>
    Effect.gen(function* () {
      out.length = 0;
      const ledger = yield* PaymentLedger;
      yield* ledger.insert(row(0));
      yield* ledger.insert(row(DAY / 2));
      yield* ledger.insert(row(3 * DAY));
      yield* TestClock.adjust((AUDIT_RETENTION_DAYS + 5) * DAY);
      yield* purgePaymentsCommand("1970-01-03");
      assert.match(out.join(""), /^Deleted 2 payment audit rows from before 1970-01-03/);
      assert.lengthOf(yield* ledger.list({ limit: 10 }), 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses a cut-off within the retention period and deletes nothing", () =>
    Effect.gen(function* () {
      out.length = 0;
      const ledger = yield* PaymentLedger;
      yield* ledger.insert(row(0));
      yield* TestClock.adjust((AUDIT_RETENTION_DAYS + 5) * DAY);
      // Today is 1971-01-06 (Prague): the latest cut-off is 1970-01-06.
      const exit = yield* Effect.exit(purgePaymentsCommand("1970-01-07"));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.include(String(exit.cause), `kept at least ${AUDIT_RETENTION_DAYS} days`);
      assert.strictEqual(out.join(""), "");
      assert.lengthOf(yield* ledger.list({ limit: 10 }), 1);
    }).pipe(Effect.provide(testLayer)),
  );
});
