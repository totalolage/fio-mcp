/**
 * SendBackground: reconcileRecovered once, expireDue every 60 s, in the layer's scope; a failing
 * or dying run is logged and the loop goes on.
 */
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit, Layer, Logger, Ref, Scope } from "effect";
import { DomainStoreError } from "../../../src/domain/errors.js";
import { SendService, type SendServiceShape } from "../../../src/domain/send/api.js";
import { SendBackground } from "../../../src/domain/send/background.js";
import { CALLER, MINUTE, SECOND, type StartedSendHarness, sendHarness } from "./support/service.js";

const SWEEP = 60 * SECOND;

/** Builds SendBackground over `service` in a scope of its own; returns that scope and its log lines. */
const startBackground = (service: SendServiceShape) =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make<unknown, void>((entry) => void logs.push(Logger.formatLogFmt.log(entry)));
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(SendBackground.pipe(Layer.provide(Layer.succeed(SendService, service))), scope).pipe(
      Effect.provide(Logger.layer([capture])),
    );
    return { scope, logs };
  });

/** The harness service with counting background runs; expireDue fails on run 2 and dies on run 3. */
const countingService = (h: StartedSendHarness) =>
  Effect.gen(function* () {
    const reconciled = yield* Ref.make(0);
    const swept = yield* Ref.make(0);
    const service: SendServiceShape = {
      ...h.service,
      reconcileRecovered: Effect.as(Ref.update(reconciled, (n) => n + 1), 0),
      expireDue: Effect.flatMap(Ref.updateAndGet(swept, (n) => n + 1), (run) => {
        if (run === 2) return Effect.fail(new DomainStoreError({ operation: "expire due filings" }));
        if (run === 3) return Effect.die("injected sweep defect");
        return Effect.succeed(0);
      }),
    };
    return { service, reconciled: Ref.get(reconciled), swept: Ref.get(swept) };
  });

describe("SendBackground", () => {
  it.effect("reconcile the recovered filings once and sweep every 60 s, past a failing and a dying sweep", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const { service, reconciled, swept } = yield* countingService(h);
      const { scope, logs } = yield* startBackground(service);

      yield* h.eventually(Effect.map(Effect.all([reconciled, swept]), ([r, s]) => r === 1 && s === 1));
      yield* h.advance(SWEEP - 1);
      assert.strictEqual(yield* swept, 1);
      yield* h.advance(1);
      yield* h.eventually(Effect.map(swept, (s) => s === 2)); // fails
      yield* h.advance(SWEEP);
      yield* h.eventually(Effect.map(swept, (s) => s === 3)); // dies
      yield* h.advance(SWEEP);
      yield* h.eventually(Effect.map(swept, (s) => s === 4)); // still running
      assert.strictEqual(yield* reconciled, 1);
      const failures = logs.filter((line) => line.includes("the filing expiry sweep failed"));
      assert.strictEqual(failures.length, 2);
      assert.include(failures[0], "expire due filings");
      assert.include(failures[1], "injected sweep defect");

      // Closing the layer's scope stops the loop.
      yield* Scope.close(scope, Exit.void);
      yield* h.advance(10 * SWEEP);
      assert.strictEqual(yield* swept, 4);
    }).pipe(Effect.scoped),
  );

  it.effect("a failing reconcileRecovered neither fails the layer nor stops the sweep", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness();
      const { service, swept } = yield* countingService(h);
      const { scope, logs } = yield* startBackground({
        ...service,
        reconcileRecovered: Effect.fail(new DomainStoreError({ operation: "reconcile" })),
      });
      yield* h.eventually(Effect.map(swept, (s) => s === 1));
      yield* h.advance(SWEEP);
      yield* h.eventually(Effect.map(swept, (s) => s === 2));
      assert.isTrue(logs.some((line) => line.includes("reconciling the recovered filings failed") && line.includes("reconcile")));
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped),
  );

  it.effect("over the real service: a filing that falls due is expired by the next sweep", () =>
    Effect.gen(function* () {
      const h = yield* sendHarness({ tiers: {} });
      const queued = yield* h.service.sendMessage(CALLER, h.request());
      const filingId = "filingId" in queued ? (queued.filingId ?? "") : "";
      yield* h.patchFiling(filingId, { expires_at: (yield* Clock.currentTimeMillis) + 30 * SECOND });
      const { scope } = yield* startBackground(h.service);

      yield* h.advance(MINUTE);
      yield* h.eventually(Effect.map(h.filing(filingId), (row) => row.state === "expired"));
      const rows = yield* h.audit("filing.expire");
      assert.deepStrictEqual(
        rows.map((row) => [row.actor_kind, row.outcome, row.detail]),
        [["system", "ok", { filingIds: [filingId] }]],
      );
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped),
  );
});
