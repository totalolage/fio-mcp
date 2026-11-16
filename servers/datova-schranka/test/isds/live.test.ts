/**
 * Opt-in live test against the ISDS PUBLIC TEST environment (datovka-test.gov.cz). Skipped
 * unless ISDS_LIVE_TEST=true. Run it with scripts/isds-live-test.sh, which reads credentials from
 * the keyring and passes them as /dev/fd pipes; nothing is written to disk.
 *
 * Configuration (Effect Config, environment variables):
 * - ISDS_LIVE_TEST=true                 enables the test.
 * - ISDS_LIVE_TEST_ROUTE=password|certificate
 *   - password:    ISDS_TEST_USERNAME_FILE, ISDS_TEST_PASSWORD_FILE
 *   - certificate: ISDS_TEST_PKCS12_FILE (binary .p12) or ISDS_TEST_PKCS12_BASE64_FILE,
 *                  plus ISDS_TEST_PKCS12_PASSPHRASE_FILE
 * - ISDS_TEST_ALLOW_DELIVERY=true       also runs GetListOfReceivedMessages, which LEGALLY DELIVERS
 *                                       every eligible received message, then downloads the newest
 *                                       one (envelope, message, signed ZFO).
 *
 * Default operations are read-only and deliver nothing: DummyOperation, GetOwnerInfoFromLogin,
 * GetListOfSentMessages. CreateMessage is never run here.
 *
 * Each file is read once (pipes can't be re-read). The run stops at the first authentication,
 * credentials or transport failure so a wrong password is tried once, not once per operation.
 * Logged results carry operation names, counts and error tags, never credentials.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Config, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { IsdsClient } from "../../src/isds/client.js";
import { type IsdsClientConfig, IsdsCredentials } from "../../src/isds/config.js";
import { IsdsTransport } from "../../src/isds/transport.js";

const enabled = Effect.runSync(
  Effect.gen(function* () {
    return yield* Config.Boolean("ISDS_LIVE_TEST").pipe(Config.withDefault(false));
  }).pipe(Effect.orElseSucceed(() => false)),
);

class LiveTestSetupError extends Schema.TaggedError<LiveTestSetupError>()("LiveTestSetupError", {
  detail: Schema.String,
}) {}

/** Reads one credential file; the error names the variable, never the content. */
const readCredentialFile = (variable: string, encoding: "utf8" | "binary") =>
  Effect.gen(function* () {
    const path = yield* Config.String(variable);
    const content = yield* Effect.try({
      try: () => readFileSync(path),
      catch: () => new LiveTestSetupError({ detail: `cannot read the file named by ${variable}` }),
    });
    if (content.length === 0) {
      return yield* new LiveTestSetupError({ detail: `the file named by ${variable} is empty` });
    }
    return encoding === "utf8" ? content.toString("utf8").replace(/\r?\n$/, "") : new Uint8Array(content);
  });

const readText = (variable: string) =>
  readCredentialFile(variable, "utf8").pipe(Effect.map((value) => value as string));

const loadCredentials = Effect.gen(function* () {
  const route = yield* Config.Literals(["password", "certificate"], "ISDS_LIVE_TEST_ROUTE");
  if (route === "password") {
    return IsdsCredentials.Password({
      username: yield* readText("ISDS_TEST_USERNAME_FILE"),
      password: Redacted.make(yield* readText("ISDS_TEST_PASSWORD_FILE")),
    });
  }
  const binaryPath = yield* Config.option(Config.String("ISDS_TEST_PKCS12_FILE"));
  const pkcs12 = Option.isSome(binaryPath)
    ? ((yield* readCredentialFile("ISDS_TEST_PKCS12_FILE", "binary")) as Uint8Array)
    : new Uint8Array(Buffer.from(yield* readText("ISDS_TEST_PKCS12_BASE64_FILE"), "base64"));
  return IsdsCredentials.SystemCertificate({
    pkcs12,
    passphrase: Redacted.make(yield* readText("ISDS_TEST_PKCS12_PASSPHRASE_FILE")),
  });
});

const liveConfig = Effect.map(
  loadCredentials,
  (credentials): IsdsClientConfig => ({
    // Always the public test environment; production is not reachable from this test.
    environment: "test",
    credentials,
    requestTimeout: Duration.seconds(60),
  }),
);

const clientLayer = Layer.unwrap(
  Effect.map(liveConfig, (config) => IsdsClient.Default.pipe(Layer.provide(IsdsTransport.layer(config)))),
);

type StepResult = { readonly operation: string; readonly outcome: string };

/** Errors after which no further call should be made (same credentials, same connection). */
const fatalTags = new Set(["IsdsAuthError", "IsdsCredentialsError", "IsdsConfigError", "IsdsTransportError"]);

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String(error._tag);
    const message = "message" in error ? String(error.message) : "";
    return `${tag}: ${message}`;
  }
  return "unknown error";
};

describe.skipIf(!enabled)("ISDS live (public test environment)", () => {
  it.live(
    "runs the authorized operations",
    () =>
      Effect.gen(function* () {
        const allowDelivery = yield* Config.Boolean("ISDS_TEST_ALLOW_DELIVERY").pipe(Config.withDefault(false));
        const results: Array<StepResult> = [];
        let stopped = false;

        const step = <A, E>(operation: string, effect: Effect.Effect<A, E>, summarize: (a: A) => string) =>
          Effect.gen(function* () {
            if (stopped) {
              results.push({ operation, outcome: "not run (stopped after a fatal error)" });
              return Option.none<A>();
            }
            const exit = yield* Effect.exit(effect);
            if (exit._tag === "Success") {
              results.push({ operation, outcome: `ok: ${summarize(exit.value)}` });
              return Option.some(exit.value);
            }
            const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
            const error = failure?._tag === "Fail" ? failure.error : undefined;
            results.push({ operation, outcome: `failed: ${failure ? describeError(error) : "defect"}` });
            if (!failure || fatalTags.has(String((error as { _tag?: unknown } | undefined)?._tag))) {
              stopped = true;
            }
            return Option.none<A>();
          });

        const client = yield* IsdsClient;
        const now = yield* DateTime.now;
        const window = { from: DateTime.subtract(now, { days: 90 }), to: now, limit: 20 };

        yield* step("DummyOperation", client.ping(), () => "connected");
        yield* step("GetOwnerInfoFromLogin", client.getOwnerInfo(), (info) => `dbType ${info.dbType ?? "?"}`);
        yield* step("GetListOfSentMessages", client.listSentMessages(window), (records) => `${records.length} records`);

        if (allowDelivery) {
          const received = yield* step(
            "GetListOfReceivedMessages (delivers)",
            client.listReceivedMessagesAndDeliver(window),
            (records) => `${records.length} records`,
          );
          const newest = Option.flatMap(received, (records) => Option.fromNullishOr(records[0]));
          if (Option.isSome(newest)) {
            const dmID = newest.value.dmID;
            yield* step("MessageEnvelopeDownload", client.downloadMessageEnvelope({ dmID }), (envelope) =>
              `state ${envelope.dmMessageStatus}`,
            );
            yield* step("MessageDownload", client.downloadMessage({ dmID }), (message) =>
              `${message.dmDm.dmFiles.length} files`,
            );
            yield* step("SignedMessageDownload", client.downloadSignedMessage({ dmID }), (signed) =>
              `${signed.dmSignature.length} ZFO bytes`,
            );
          } else {
            results.push({ operation: "downloads", outcome: "skipped: no received message in the window" });
          }
        }

        yield* Effect.logInfo(
          `ISDS live results:\n${results.map((r) => `  ${r.operation}: ${r.outcome}`).join("\n")}`,
        );
        expect(results.filter((r) => !r.outcome.startsWith("ok") && !r.outcome.startsWith("skipped"))).toEqual([]);
      }).pipe(Effect.provide(clientLayer)),
    120_000,
  );
});
