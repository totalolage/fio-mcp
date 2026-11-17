import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_KEY } from "@mcps/core/instance-lease.js";
import { Cause, Effect, Exit, Fiber, Layer, Logger, Option } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURES, serve } from "../../src/app/app.js";
import { appEnv, appPlatform } from "../support/app.js";

const dirs: Array<string> = [];
const fibers: Array<Fiber.Fiber<unknown, unknown>> = [];

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await Effect.runPromise(Fiber.interrupt(fiber));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Started {
  readonly fiber: Fiber.Fiber<never, unknown>;
  /** Resolves true once the background layer is built, false when serve ends first. */
  readonly started: Promise<boolean>;
  /** Whether the lease row existed when the background layer was built. */
  readonly leaseRowAtBackground: Array<boolean>;
}

/** `datova-schranka serve` (src/app/app.ts serve) on `dir`, with a background layer that reports when it is built. */
async function serveOn(dir: string): Promise<Started> {
  const platform = await appPlatform(await appEnv(dir), []);
  const leaseRowAtBackground: Array<boolean> = [];
  let built: () => void = () => undefined;
  const backgroundBuilt = new Promise<void>((resolve) => {
    built = resolve;
  });
  const background = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly key: string }>`SELECT key FROM server_settings WHERE key = ${LEASE_KEY}`;
      leaseRowAtBackground.push(rows.length === 1);
      built();
    }).pipe(Effect.orDie),
  );
  const fiber = Effect.runFork(
    serve({ ...FEATURES, background }).pipe(Effect.provide(Layer.mergeAll(platform, Logger.layer([])))),
  );
  fibers.push(fiber);
  const ended = Effect.runPromise(Fiber.await(fiber)).then(() => false);
  return { fiber, started: Promise.race([backgroundBuilt.then(() => true), ended]), leaseRowAtBackground };
}

describe("serve", () => {
  it("builds the background layer only once the lease is held; a second server on the database is refused before it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "datova-schranka-lease-"));
    dirs.push(dir);

    const first = await serveOn(dir);
    expect(await first.started).toBe(true);
    expect(first.leaseRowAtBackground).toEqual([true]);

    const blocked = await serveOn(dir);
    expect(await blocked.started).toBe(false);
    expect(blocked.leaseRowAtBackground).toEqual([]);
    const exit = await Effect.runPromise(Fiber.await(blocked.fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.map(error, (value) => (value as { _tag?: string })._tag)).toEqual(Option.some("InstanceLeaseHeld"));
    }

    await Effect.runPromise(Fiber.interrupt(first.fiber));
    const second = await serveOn(dir);
    expect(await second.started).toBe(true);
    expect(second.leaseRowAtBackground).toEqual([true]);
  });
});
