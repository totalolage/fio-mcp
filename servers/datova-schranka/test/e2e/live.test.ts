/**
 * Opt-in live smoke test of the composed app against the ISDS PUBLIC TEST environment
 * (datovka-test.gov.cz). Skipped unless DS_LIVE_SMOKE=true. Run it with
 * scripts/datova-schranka-live-smoke.sh, which reads credentials from the keyring and passes them
 * as /dev/fd pipes, never as files. The app under test keeps what an app keeps: the box's
 * credentials sealed with the throwaway data key in its temp database, and the downloaded ZFO in
 * its temp data dir; the harness removes that dir at close.
 *
 * The HTTP app runs in-process with a temp database, data dir, throwaway data key and admin
 * password hash, and the real ISDS transports for environment `test`. The box is added through
 * the admin action, the grant is consented in the browser harness, and then the read tools run
 * over MCP: get_server_status, list_sent_messages, list_received_messages (this DELIVERS the
 * box's received messages; no legal effect in the test environment), get_message and
 * download_message on the newest received message, get_message_state_changes. Nothing is sent.
 *
 * Configuration (Effect Config, environment variables):
 * - DS_LIVE_SMOKE=true                        enables the test.
 * - DS_LIVE_SMOKE_ROUTE=password|certificate
 *   - password:    DS_LIVE_SMOKE_USERNAME_FILE, DS_LIVE_SMOKE_PASSWORD_FILE
 *   - certificate: DS_LIVE_SMOKE_PKCS12_FILE (binary), DS_LIVE_SMOKE_PKCS12_PASSPHRASE_FILE
 *
 * Each file is read once (pipes can't be re-read). Logged results are tool names, outcomes,
 * isError flags, counts, states and sizes: never credentials, message ids or message content.
 */
import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Config, Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type AdminOutcome, type AdminSession, startE2eApp } from "./support/app.js";

const enabled = Effect.runSync(
  Config.Boolean("DS_LIVE_SMOKE").pipe(Config.withDefault(false), Effect.orElseSucceed(() => false)),
);

class LiveSmokeSetupError extends Schema.TaggedError<LiveSmokeSetupError>()("LiveSmokeSetupError", {
  detail: Schema.String,
}) {}

/** Reads one credential file once; the error names the variable, never the content. */
const readCredentialFile = (variable: string) =>
  Effect.gen(function* () {
    const path = yield* Config.String(variable);
    const content = yield* Effect.try({
      try: () => readFileSync(path),
      catch: () => new LiveSmokeSetupError({ detail: `cannot read the file named by ${variable}` }),
    });
    if (content.length === 0) {
      return yield* new LiveSmokeSetupError({ detail: `the file named by ${variable} is empty` });
    }
    return content;
  });

const readText = (variable: string) =>
  readCredentialFile(variable).pipe(Effect.map((content) => content.toString("utf8").replace(/\r?\n$/, "")));

const loadCredentials = Effect.gen(function* () {
  const route = yield* Config.Literals(["password", "certificate"], "DS_LIVE_SMOKE_ROUTE");
  if (route === "password") {
    return {
      route: "password" as const,
      username: yield* readText("DS_LIVE_SMOKE_USERNAME_FILE"),
      password: yield* readText("DS_LIVE_SMOKE_PASSWORD_FILE"),
    };
  }
  return {
    route: "certificate" as const,
    pkcs12: new Uint8Array(yield* readCredentialFile("DS_LIVE_SMOKE_PKCS12_FILE")),
    passphrase: yield* readText("DS_LIVE_SMOKE_PKCS12_PASSPHRASE_FILE"),
  };
});

const LABEL = "live-test";

/**
 * Above the app's ISDS request timeout (60 s), so one slow ISDS call ends as the app's own tool
 * error. download_message makes two ISDS calls in sequence, so two slow ones can still reach it.
 */
const MCP_REQUEST_TIMEOUT_MS = 90_000;

type Json = Record<string, unknown>;
type StepResult = { readonly step: string; readonly ok: boolean; readonly outcome: string };

const textOf = (result: CallToolResult): string =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

/** The tool's JSON output: structured content, else the first text block. */
const jsonOf = (result: CallToolResult): Json => {
  if (result.structuredContent !== undefined) return result.structuredContent as Json;
  const first = result.content.find((block) => block.type === "text");
  return first?.type === "text" ? (JSON.parse(first.text) as Json) : {};
};

const countOf = (json: Json, field: string): number => {
  const value = json[field];
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" ? value : -1;
};

/** The outcome and error tag of the newest audit row of `action` (detail is JSON text; only the tag is reported). */
const auditTag = async (admin: AdminSession, action: string): Promise<string> => {
  const row = (await admin.auditRows()).find((candidate) => candidate.action === action);
  if (row === undefined) return `no ${action} audit row`;
  const match = /"error"\s*:\s*"([A-Za-z]+)"/.exec(row.detail) ?? /\b([A-Z][A-Za-z]*Error)\b/.exec(row.detail);
  return `audit ${row.outcome}, error ${match?.[1] ?? "unknown"}`;
};

/** The id of the most recently delivered record (ISDS's list order is not guaranteed). */
const newestId = (records: ReadonlyArray<Json>): string | undefined => {
  const time = (record: Json) => Date.parse(String(record.dmDeliveryTime ?? ""));
  const newest = records.reduce<Json | undefined>(
    (best, record) => (best === undefined || time(record) > time(best) ? record : best),
    undefined,
  );
  return typeof newest?.dmID === "string" ? newest.dmID : undefined;
};

describe.skipIf(!enabled)("datova-schranka app live (ISDS public test environment)", () => {
  it(
    "adds the box, consents and runs the read tools",
    async () => {
      const credentials = await Effect.runPromise(loadCredentials);
      const secrets =
        credentials.route === "password"
          ? [credentials.username, credentials.password]
          : [credentials.passphrase, Buffer.from(credentials.pkcs12).toString("base64")];
      const results: Array<StepResult> = [];
      const record = (step: string, ok: boolean, outcome: string) => results.push({ step, ok, outcome });
      // Every text that leaves the app is checked here; only the verdict is recorded, never the text.
      const leaks: Array<string> = [];
      // Texts the harness returns (admin pages, logs) are already scrubbed by it; tool results are raw.
      const checkNoSecret = (where: string, text: string | undefined) => {
        if (text !== undefined && secrets.some((secret) => secret.length > 0 && text.includes(secret))) {
          leaks.push(where);
        }
      };

      const app = await startE2eApp({ isds: "live" });
      let completed = false;
      const runTools = async (admin: AdminSession) => {
          const grant = await app.consent({ boxes: [LABEL], scopes: ["isds:read"], deliveryConsent: true });
          record("OAuth consent", true, "granted isds:read with delivery consent");
          const mcp = await app.mcp(grant.access, { requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS });

          const call = async (name: string, args: Json, summarize: (json: Json, result: CallToolResult) => string) => {
            const result = await mcp.call(name, args);
            const text = textOf(result);
            checkNoSecret(name, text);
            checkNoSecret(name, JSON.stringify(result));
            if (result.isError === true) {
              // The error text is not logged (it can quote ISDS or message data); the audit row's tag is.
              record(name, false, `isError true, ${await auditTag(admin, name)}`);
              return Option.none<Json>();
            }
            const json = jsonOf(result);
            record(name, true, `isError false, ${summarize(json, result)}`);
            return Option.some(json);
          };

          await call("get_server_status", {}, (json) => {
            const grantInfo = (json.grant ?? {}) as Json;
            const scopes = Array.isArray(grantInfo.scopes) ? grantInfo.scopes.join(" ") : "?";
            return `environment ${String(json.environment)}, ${countOf(json, "boxes")} boxes, scopes ${scopes}`;
          });
          await call("list_sent_messages", { box: LABEL }, (json) => `${countOf(json, "records")} records`);
          const received = await call(
            "list_received_messages",
            { box: LABEL },
            (json) => `${countOf(json, "records")} records${json.note === undefined ? "" : ", with note"}`,
          );

          const newest = Option.flatMap(received, (json) =>
            Option.fromNullishOr(newestId(Array.isArray(json.records) ? (json.records as ReadonlyArray<Json>) : [])),
          );
          if (Option.isSome(newest)) {
            const messageId = newest.value;
            await call("get_message", { box: LABEL, messageId }, (json) => {
              const message = (json.message ?? {}) as Json;
              return `state ${String(message.dmMessageStatus ?? "?")}`;
            });
            await call("download_message", { box: LABEL, messageId }, (json, result) => {
              const blobs = result.content.flatMap((block) =>
                block.type === "resource" && "blob" in block.resource ? [block.resource.blob] : [],
              );
              const bytes = blobs.reduce((sum, blob) => sum + Buffer.from(blob, "base64").length, 0);
              return `${countOf(json, "attachments")} attachments, ${blobs.length} inline (${bytes} bytes)`;
            });
          } else {
            record("get_message, download_message", true, "skipped: no received message in the window");
          }
          await call("get_message_state_changes", { box: LABEL }, (json) => `${countOf(json, "changes")} changes`);
      };

      try {
        const admin = await app.admin();
        const added: AdminOutcome =
          credentials.route === "password"
            ? await admin.addPasswordBox({
                label: LABEL,
                username: credentials.username,
                password: credentials.password,
              })
            : await admin.addCertificateBox({
                label: LABEL,
                pkcs12: credentials.pkcs12,
                passphrase: credentials.passphrase,
              });
        checkNoSecret("add box page", added.text);
        if (!added.added) {
          record(`add box (${credentials.route})`, false, `not added: status ${added.status}, ${await auditTag(admin, "box_add")}`);
        } else {
          record(`add box (${credentials.route})`, true, `added, status ${added.status}`);
          await runTools(admin);
        }
        completed = true;
      } finally {
        for (const line of app.logs()) checkNoSecret("server log", line);
        const coverage = completed ? "clean" : "clean as far as the run got (it stopped early)";
        const leakCheck = leaks.length > 0 ? `found in ${leaks.join(", ")}` : coverage;
        console.info(
          `datova-schranka live results:\n${results.map((r) => `  ${r.step}: ${r.ok ? "ok" : "FAILED"}: ${r.outcome}`).join("\n")}\n  credential leak check: ${leakCheck}`,
        );
        await app.close();
      }
      expect(leaks).toEqual([]);
      expect(results.filter((r) => !r.ok)).toEqual([]);
    },
    180_000,
  );
});
