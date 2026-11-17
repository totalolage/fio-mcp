import { ADMIN_PATH } from "@mcps/core/admin/sessions.js";
import type { AdminTab } from "@mcps/core/admin/tab.js";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../../src/domain/audit-log.js";
import { BoxRegistry } from "../../src/domain/boxes.js";
import { AdminBrowser, type AdminHarness, startAdmin } from "./support/admin-harness.js";

/** The harness itself: a tab reading app services is served at /admin after sign-in, and its actions get the CSRF-checked form. */

const probeTab = Effect.gen(function* () {
  const registry = yield* BoxRegistry;
  const audit = yield* AuditLog;
  const tab: AdminTab = {
    id: "probe",
    label: "Probe",
    path: ADMIN_PATH,
    render: () => Effect.map(registry.list, (boxes) => ({ body: `<h1>Probe</h1><p>${boxes.length} boxes</p>` })),
    actions: [
      {
        path: `${ADMIN_PATH}/probe`,
        run: () =>
          audit.record({ actor: { kind: "admin" }, action: "probe", outcome: "ok" }).pipe(
            Effect.orDie,
            Effect.as({ kind: "ok" as const, text: "Probed <ok>." }),
          ),
      },
    ],
  };
  return [tab];
});

let app: AdminHarness | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("admin harness", () => {
  it("signs in, renders the tab and runs an action with the services", async () => {
    app = await startAdmin(probeTab);
    const browser = new AdminBrowser(app);
    expect((await browser.signIn()).status).toBe(303);
    const page = await browser.get("/admin");
    expect(page.html).toContain("0 boxes");
    const acted = await browser.act("/admin/probe", {});
    expect(acted.flash).toEqual({ kind: "ok", text: "Probed <ok>." });
    const audit = await app.run(Effect.flatMap(AuditLog, (log) => log.list()));
    expect(audit.entries.map((entry) => entry.action)).toEqual(["probe"]);
  });
});
