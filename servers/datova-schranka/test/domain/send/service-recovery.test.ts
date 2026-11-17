/**
 * Startup recovery (C4, D-i): building the service turns every 'dispatching' filing into
 * outcome_unknown with its payload cleared and one system "filing.recover" audit row each, in
 * one transaction; a failure fails construction.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { CALLER, makeSendHarness } from "./support/service.js";

/** A harness with two queued filings planted as 'dispatching' (payload kept) and one left queued. */
const plantedHarness = Effect.gen(function* () {
  const h = yield* makeSendHarness({ tiers: {} });
  const first = yield* h.start;
  const ids: Array<string> = [];
  for (const key of ["key-1", "key-2", "key-3"]) {
    const queued = yield* first.sendMessage(CALLER, h.request({ idempotencyKey: key }));
    if (queued._tag !== "Queued") return yield* Effect.die(queued._tag);
    ids.push(queued.filingId);
  }
  const [a = "", b = "", queued = ""] = ids;
  for (const id of [a, b]) yield* h.patchFiling(id, { state: "dispatching", submitted_at: 1 });
  return { h, dispatching: [a, b], queued };
});

describe("SendService startup recovery", () => {
  it.effect("turn each dispatching filing outcome_unknown, payload cleared, one system audit row each", () =>
    Effect.gen(function* () {
      const { h, dispatching, queued } = yield* plantedHarness;
      assert.isString((yield* h.filing(dispatching[0] ?? "")).payload_sealed);
      yield* h.start;

      for (const id of dispatching) {
        const row = yield* h.filing(id);
        assert.strictEqual(row.state, "outcome_unknown");
        assert.isNull(row.payload_sealed);
      }
      const untouched = yield* h.filing(queued);
      assert.strictEqual(untouched.state, "pending_admin");
      assert.isString(untouched.payload_sealed);

      const recovered = yield* h.audit("filing.recover");
      assert.deepStrictEqual(
        recovered.map((row) => [row.actor_kind, row.outcome, row.box_id]),
        [
          ["system", "uncertain", h.box.id],
          ["system", "uncertain", h.box.id],
        ],
      );
      assert.sameMembers(
        recovered.map((row) => (row.detail as { readonly filingId: string }).filingId),
        dispatching,
      );
      for (const row of recovered) assert.deepStrictEqual(Object.keys(row.detail as object), ["filingId"]);
      assert.strictEqual(h.calls("CreateMessage"), 0);

      // A further restart finds nothing to recover.
      yield* h.start;
      assert.strictEqual((yield* h.audit("filing.recover")).length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("fail construction when recovery fails, leaving the filings dispatching and unaudited", () =>
    Effect.gen(function* () {
      const { h, dispatching } = yield* plantedHarness;
      yield* h.exec(
        `CREATE TRIGGER fail_recover BEFORE UPDATE ON filings WHEN NEW.state = 'outcome_unknown'
         BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`,
      );
      const exit = yield* Effect.exit(h.tryStart);
      assert.isTrue(Exit.isFailure(exit));
      for (const id of dispatching) assert.strictEqual((yield* h.filing(id)).state, "dispatching");
      assert.deepStrictEqual(yield* h.audit("filing.recover"), []);
    }).pipe(Effect.scoped),
  );
});
