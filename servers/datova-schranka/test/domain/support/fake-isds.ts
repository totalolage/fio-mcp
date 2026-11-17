import { Effect, Layer, Redacted } from "effect";
import { IsdsTransports } from "../../../src/domain/isds-transports.js";
import { type IsdsClientConfig, IsdsCredentials } from "../../../src/isds/config.js";
import type { IsdsConfigError, IsdsCredentialsError, IsdsTransportFailure } from "../../../src/isds/errors.js";
import type { IsdsSoapRequest, IsdsSoapResponse } from "../../../src/isds/transport.js";
import { fixture, ok } from "../../isds/fake-transport.js";

export type FakeRespond = (
  config: IsdsClientConfig,
  request: IsdsSoapRequest,
) => Effect.Effect<IsdsSoapResponse, IsdsTransportFailure>;

export interface FakeIsdsOptions {
  /** Fails `make` for some configs (e.g. an unreadable PKCS#12). */
  readonly onMake?: (config: IsdsClientConfig) => Effect.Effect<void, IsdsCredentialsError | IsdsConfigError>;
}

/**
 * An `IsdsTransports` whose every transport answers with `respond(config, request)`.
 * `made` records each `make` call's config, `requests` every request with the config it went out under.
 */
export const fakeIsdsTransports = (respond: FakeRespond, options: FakeIsdsOptions = {}) => {
  const made: Array<IsdsClientConfig> = [];
  const requests: Array<{ readonly config: IsdsClientConfig; readonly request: IsdsSoapRequest }> = [];
  const layer = Layer.succeed(
    IsdsTransports,
    IsdsTransports.of({
      make: (config) =>
        Effect.gen(function* () {
          if (options.onMake !== undefined) yield* options.onMake(config);
          made.push(config);
          return {
            send: (request: IsdsSoapRequest) =>
              Effect.suspend(() => {
                requests.push({ config, request });
                return respond(config, request);
              }),
          };
        }),
    }),
  );
  return { layer, made, requests };
};

/** GetOwnerInfoFromLogin's canned answer with the box id swapped for `dbId`. */
export const ownerInfoXml = (dbId: string): string =>
  fixture("GetOwnerInfoFromLogin.xml").replace("<p:dbID>abc2def<", `<p:dbID>${dbId}<`);

/** Which identity the credentials log in as: the username, or the certificate's passphrase. */
export const loginKey = (credentials: IsdsCredentials): string =>
  IsdsCredentials.$match(credentials, {
    Password: ({ username }) => username,
    SystemCertificate: ({ passphrase }) => Redacted.value(passphrase),
  });

/**
 * Answers GetOwnerInfoFromLogin with the dbID `logins` maps the credentials' login key to,
 * and DummyOperation with success; anything else goes to `otherwise` (default: an empty 200).
 */
export const loginResponder =
  (logins: Readonly<Record<string, string>>, otherwise?: FakeRespond): FakeRespond =>
  (config, request) => {
    if (request.operation === "GetOwnerInfoFromLogin") {
      const dbId = logins[loginKey(config.credentials)] ?? "zzz0000";
      return Effect.succeed(ok(ownerInfoXml(dbId)));
    }
    if (request.operation === "DummyOperation") return Effect.succeed(ok(fixture("DummyOperation.xml")));
    return otherwise === undefined ? Effect.succeed(ok("")) : otherwise(config, request);
  };

export const passwordCredentials = (username: string, password = `secret-of-${username}`): IsdsCredentials =>
  IsdsCredentials.Password({ username, password: Redacted.make(password) });

export const certificateCredentials = (
  passphrase: string,
  pkcs12: Uint8Array = new TextEncoder().encode(`p12-bytes-${passphrase}`),
): IsdsCredentials => IsdsCredentials.SystemCertificate({ pkcs12, passphrase: Redacted.make(passphrase) });
