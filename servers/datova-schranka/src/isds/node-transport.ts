import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { Duration, Effect, Redacted } from "effect";
import { defaultMaxResponseBytes, type IsdsClientConfig, type IsdsService, isdsServicePath, resolveBaseUrl } from "./config.js";
import {
  IsdsAuthError,
  IsdsConfigError,
  IsdsCredentialsError,
  IsdsHttpError,
  IsdsMaintenanceError,
  IsdsTimeoutError,
  IsdsTransportError,
  type IsdsTransportFailure,
} from "./errors.js";
import type { IsdsSoapRequest, IsdsSoapResponse, IsdsTransportShape } from "./transport.js";

/** Every operation in the vendored WSDLs declares `soapAction=""`. */
const soapAction = '""';

/** setTimeout fires at once for delays over 2^31 - 1 ms, so longer timeouts are rejected. */
const maxTimeoutMillis = 2_147_483_647;

const tlsErrorCodes = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "HOSTNAME_MISMATCH",
  "EPROTO",
]);

const isTlsError = (code: string): boolean =>
  code.startsWith("ERR_TLS_") ||
  code.startsWith("ERR_SSL_") ||
  code.startsWith("CERT_") ||
  code.startsWith("UNABLE_TO_") ||
  tlsErrorCodes.has(code);

const errorCode = (error: Error): string => {
  const code: unknown = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : "";
};

const describe = (cause: unknown): string => {
  if (cause instanceof Error) {
    const code = errorCode(cause);
    return code === "" ? cause.message : `${code}: ${cause.message}`;
  }
  return String(cause);
};

/** Removes `secret` from a message, in case a library echoes it back. */
const scrub = (message: string, secret: string): string =>
  secret === "" ? message : message.split(secret).join("<redacted>");

interface RequestContext {
  readonly service: IsdsService;
  readonly operation: string;
}

const connectionFailure = (context: RequestContext, error: Error): IsdsTransportError =>
  new IsdsTransportError({
    ...context,
    reason: isTlsError(errorCode(error)) ? "Tls" : "Connection",
    detail: describe(error),
  });

const validateConfig = Effect.fn("IsdsTransport.validateConfig")(function* (config: IsdsClientConfig) {
  const base = yield* Effect.try({
    try: () => new URL(resolveBaseUrl(config)),
    catch: () => new IsdsConfigError({ detail: "the base URL is not a valid URL" }),
  });
  if (base.protocol !== "https:") {
    return yield* new IsdsConfigError({ detail: `the base URL must use https:, not ${base.protocol}` });
  }
  if (base.username !== "" || base.password !== "") {
    return yield* new IsdsConfigError({ detail: "the base URL must not contain credentials" });
  }
  if (base.search !== "" || base.hash !== "") {
    return yield* new IsdsConfigError({ detail: "the base URL must not have a query or fragment" });
  }
  const timeoutMillis = Duration.toMillis(config.requestTimeout);
  if (!(Number.isFinite(timeoutMillis) && timeoutMillis > 0 && timeoutMillis <= maxTimeoutMillis)) {
    return yield* new IsdsConfigError({
      detail: `requestTimeout must be between 1 ms and ${maxTimeoutMillis} ms, got ${timeoutMillis} ms`,
    });
  }
  const maxResponseBytes = config.maxResponseBytes ?? defaultMaxResponseBytes;
  if (!(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0)) {
    return yield* new IsdsConfigError({ detail: `maxResponseBytes must be a positive integer, got ${maxResponseBytes}` });
  }
  const prefix = base.href.replace(/\/+$/, "");
  const endpoint = (service: IsdsService): URL => new URL(`${prefix}${isdsServicePath[service]}`);
  const endpoints: Record<IsdsService, URL> = {
    operations: endpoint("operations"),
    info: endpoint("info"),
    search: endpoint("search"),
    access: endpoint("access"),
  };
  return { endpoints, timeoutMillis, maxResponseBytes };
});

/**
 * The TLS context for every connection: Node's bundled roots plus `additionalTrustedCa`, TLS 1.2
 * or later, and the PKCS#12 client certificate on the system-certificate route. Built once, so a
 * bad archive or passphrase fails the layer instead of the first request.
 */
const makeSecureContext = Effect.fn("IsdsTransport.makeSecureContext")(function* (config: IsdsClientConfig) {
  const ca = [...tls.rootCertificates, ...(config.additionalTrustedCa ?? [])];
  const base: tls.SecureContextOptions = { ca, minVersion: "TLSv1.2" };
  const serverOnly = yield* Effect.try({
    try: () => tls.createSecureContext(base),
    catch: (cause) => new IsdsConfigError({ detail: `additionalTrustedCa was rejected: ${describe(cause)}` }),
  });
  const credentials = config.credentials;
  if (credentials._tag !== "SystemCertificate") {
    return serverOnly;
  }
  const passphrase = Redacted.value(credentials.passphrase);
  return yield* Effect.try({
    try: () => tls.createSecureContext({ ...base, pfx: Buffer.from(credentials.pkcs12), passphrase }),
    catch: (cause) =>
      new IsdsCredentialsError({
        detail: `the PKCS#12 archive or its passphrase was rejected (${scrub(describe(cause), passphrase)})`,
      }),
  });
});

/** The HTTP Basic `Authorization` value on the password route. */
const makeAuthorization = Effect.fn("IsdsTransport.makeAuthorization")(function* (config: IsdsClientConfig) {
  const credentials = config.credentials;
  if (credentials._tag !== "Password") {
    return undefined;
  }
  if (credentials.username.includes(":")) {
    return yield* new IsdsCredentialsError({ detail: "the username must not contain ':' (HTTP Basic)" });
  }
  const token = Buffer.from(`${credentials.username}:${Redacted.value(credentials.password)}`, "utf8").toString("base64");
  return Redacted.make(`Basic ${token}`);
});

/**
 * The live transport: one keep-alive HTTPS agent per layer, destroyed when the layer's scope
 * closes. The server certificate is always verified. Requests are never retried here.
 */
export const makeNodeTransport = Effect.fn("IsdsTransport.make")(function* (config: IsdsClientConfig) {
  const { endpoints, timeoutMillis, maxResponseBytes } = yield* validateConfig(config);
  const secureContext = yield* makeSecureContext(config);
  const authorization = yield* makeAuthorization(config);
  const agent = yield* Effect.acquireRelease(
    Effect.sync(() => new https.Agent({ keepAlive: true, secureContext, minVersion: "TLSv1.2", rejectUnauthorized: true })),
    (agent) => Effect.sync(() => agent.destroy()),
  );

  const send = Effect.fn("IsdsTransport.send")(function* (request: IsdsSoapRequest) {
    const context: RequestContext = { service: request.service, operation: request.operation };
    const body = Buffer.from(request.envelope, "utf8");
    const headers: Record<string, string> = {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: soapAction,
      "Content-Length": String(body.byteLength),
    };
    if (authorization !== undefined) {
      headers.Authorization = Redacted.value(authorization);
    }

    return yield* Effect.callback<IsdsSoapResponse, IsdsTransportFailure>((resume) => {
      let settled = false;
      // True once the whole body has been written to the TLS socket: from then on ISDS may act on it.
      let requestSent = false;
      const req = https.request(endpoints[request.service], { method: "POST", agent, headers });

      const settle = (effect: Effect.Effect<IsdsSoapResponse, IsdsTransportFailure>): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resume(effect);
      };
      const abort = (error: IsdsTransportFailure): void => {
        settle(Effect.fail(error));
        req.destroy();
      };
      const tooLarge = (bytes: number): IsdsTransportError =>
        new IsdsTransportError({
          ...context,
          reason: "ResponseTooLarge",
          detail: `the response is ${bytes} bytes or more, over the ${maxResponseBytes}-byte limit`,
        });

      const timer = setTimeout(() => abort(new IsdsTimeoutError({ ...context, timeoutMillis, requestSent })), timeoutMillis);

      const onResponse = (res: IncomingMessage): void => {
        res.on("error", (error) => settle(Effect.fail(connectionFailure(context, error))));
        const status = res.statusCode ?? 0;
        const contentType = res.headers["content-type"];
        if (status === 401 || status === 403) {
          abort(new IsdsAuthError({ ...context, httpStatus: status }));
          return;
        }
        if (status === 503) {
          const retryAfter = res.headers["retry-after"];
          abort(new IsdsMaintenanceError({ ...context, ...(retryAfter === undefined ? {} : { retryAfter }) }));
          return;
        }
        if (status !== 200 && status !== 500) {
          abort(
            new IsdsHttpError({ ...context, httpStatus: status, ...(contentType === undefined ? {} : { contentType }) }),
          );
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          abort(tooLarge(declared));
          return;
        }
        const chunks: Array<Buffer> = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > maxResponseBytes) {
            abort(tooLarge(received));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          settle(
            Effect.succeed({
              httpStatus: status,
              contentType,
              body: Buffer.concat(chunks, received).toString("utf8"),
            }),
          ),
        );
      };

      req.on("finish", () => {
        // A destroyed request also emits 'finish'; only a completed write counts as sent.
        if (!req.destroyed) {
          requestSent = true;
        }
      });
      req.on("response", onResponse);
      req.on("error", (error) => settle(Effect.fail(connectionFailure(context, error))));
      req.on("close", () =>
        settle(
          Effect.fail(
            new IsdsTransportError({
              ...context,
              reason: "Connection",
              detail: "the connection closed before the response was complete",
            }),
          ),
        ),
      );
      req.end(body);

      return Effect.sync(() => {
        settled = true;
        clearTimeout(timer);
        req.destroy();
      });
    });
  });

  return { send } satisfies IsdsTransportShape;
});
