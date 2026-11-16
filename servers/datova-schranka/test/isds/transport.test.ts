import { Buffer } from "node:buffer";
import { beforeAll, describe, expect, it } from "@effect/vitest";
import { Context, Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { type IsdsClientConfig, IsdsCredentials, type IsdsService, isdsServicePath } from "../../src/isds/config.js";
import { type IsdsSoapRequest, IsdsTransport } from "../../src/isds/transport.js";
import { createTestPki, type TestPki } from "./support/pki.js";
import { type Handler, httpsServer, silentTcpServer } from "./support/server.js";

let pki: TestPki;
beforeAll(() => {
  pki = createTestPki();
});

const envelope = '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>Žluťoučký kůň</s:Body></s:Envelope>';
const okBody = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>úspěch</s:Body></s:Envelope>';
const faultBody =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>chyba</faultstring></s:Fault></s:Body></s:Envelope>';
const username = "box-user";
const password = "pw-secret-91d3f7";

const request = (service: IsdsService = "info", body = envelope): IsdsSoapRequest => ({
  service,
  operation: "GetListOfReceivedMessages",
  envelope: body,
});

const certificateConfig = (port: number, overrides: Partial<IsdsClientConfig> = {}): IsdsClientConfig => ({
  environment: "test",
  baseUrl: `https://127.0.0.1:${port}/cert`,
  credentials: IsdsCredentials.SystemCertificate({
    pkcs12: pki.clientPkcs12,
    passphrase: Redacted.make(pki.clientPassphrase),
  }),
  additionalTrustedCa: [pki.caCert],
  requestTimeout: Duration.seconds(5),
  ...overrides,
});

const passwordConfig = (port: number, overrides: Partial<IsdsClientConfig> = {}): IsdsClientConfig => ({
  environment: "test",
  baseUrl: `https://127.0.0.1:${port}`,
  credentials: IsdsCredentials.Password({ username, password: Redacted.make(password) }),
  additionalTrustedCa: [pki.caCert],
  requestTimeout: Duration.seconds(5),
  ...overrides,
});

/** Builds the live transport in the test's scope, so its agent outlives a single request. */
const makeTransport = (config: IsdsClientConfig) =>
  Layer.build(IsdsTransport.layer(config)).pipe(Effect.map((context) => Context.get(context, IsdsTransport)));

const respond =
  (status: number, body: string, headers: Record<string, string> = {}): Handler =>
  (_request, res) => {
    res.writeHead(status, { "Content-Type": "text/xml; charset=utf-8", ...headers });
    res.end(body);
  };

const never: Handler = () => {};

/** Every way an error can be rendered; a secret must appear in none of them. */
const renderings = (error: unknown): string => {
  const record = error as { message?: unknown };
  return [String(error), String(record.message), JSON.stringify(error)].join("\n");
};

describe("IsdsTransport (Node https)", () => {
  it.live("presents the PKCS#12 client certificate, which the server verifies", () =>
    Effect.gen(function* () {
      const server = yield* httpsServer({ ...pki.server, clientCa: pki.caCert }, respond(200, okBody));
      const transport = yield* makeTransport(certificateConfig(server.port));

      const response = yield* transport.send(request());

      expect(response).toEqual({ httpStatus: 200, contentType: "text/xml; charset=utf-8", body: okBody });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.clientAuthorized).toBe(true);
      expect(server.requests[0]?.clientCommonName).toBe(pki.clientCommonName);
      expect(server.requests[0]?.headers.authorization).toBeUndefined();
    }),
  );

  it.live("posts the envelope with the SOAP headers to each service's path", () =>
    Effect.gen(function* () {
      const server = yield* httpsServer({ ...pki.server, clientCa: pki.caCert }, respond(200, okBody));
      const transport = yield* makeTransport(certificateConfig(server.port));
      const services: ReadonlyArray<IsdsService> = ["operations", "info", "search", "access"];

      for (const service of services) {
        yield* transport.send(request(service));
      }

      expect(server.requests.map((received) => received.url)).toEqual([
        "/cert/DS/dz",
        "/cert/DS/dx",
        "/cert/DS/df",
        "/cert/DS/DsManage",
      ]);
      expect(services.map((service) => `/cert${isdsServicePath[service]}`)).toEqual(
        server.requests.map((received) => received.url),
      );
      for (const received of server.requests) {
        expect(received.method).toBe("POST");
        expect(received.headers["content-type"]).toBe("text/xml; charset=utf-8");
        expect(received.headers.soapaction).toBe('""');
        expect(received.headers["content-length"]).toBe(String(Buffer.byteLength(envelope, "utf8")));
        expect(received.body).toBe(envelope);
      }
    }),
  );

  it.live("fails with reason Tls on a server certificate from an untrusted CA", () =>
    Effect.gen(function* () {
      const rogue = yield* httpsServer(pki.rogueServer, respond(200, okBody));
      const rogueError = yield* Effect.flip(
        makeTransport(certificateConfig(rogue.port)).pipe(Effect.flatMap((transport) => transport.send(request()))),
      );
      expect(rogueError._tag).toBe("IsdsTransportError");
      expect(rogueError).toMatchObject({ reason: "Tls", service: "info", operation: "GetListOfReceivedMessages" });
      expect(rogue.requests).toHaveLength(0);

      // The test CA's own server is untrusted too unless its CA is configured: only Node's roots apply.
      const server = yield* httpsServer(pki.server, respond(200, okBody));
      const error = yield* Effect.flip(
        makeTransport(passwordConfig(server.port, { additionalTrustedCa: undefined })).pipe(
          Effect.flatMap((transport) => transport.send(request())),
        ),
      );
      expect(error).toMatchObject({ _tag: "IsdsTransportError", reason: "Tls" });
      expect(server.requests).toHaveLength(0);
    }),
  );

  it.live("rejects a wrong PKCS#12 passphrase when the layer is built, without echoing it", () =>
    Effect.gen(function* () {
      const wrong = "wrong-passphrase-0b7e";
      const error = yield* Effect.flip(
        makeTransport(
          certificateConfig(443, {
            credentials: IsdsCredentials.SystemCertificate({ pkcs12: pki.clientPkcs12, passphrase: Redacted.make(wrong) }),
          }),
        ),
      );
      expect(error._tag).toBe("IsdsCredentialsError");
      expect(renderings(error)).not.toContain(wrong);
      expect(renderings(error)).not.toContain(pki.clientPassphrase);

      const corrupt = yield* Effect.flip(
        makeTransport(
          certificateConfig(443, {
            credentials: IsdsCredentials.SystemCertificate({
              pkcs12: new Uint8Array([1, 2, 3, 4]),
              passphrase: Redacted.make(pki.clientPassphrase),
            }),
          }),
        ),
      );
      expect(corrupt._tag).toBe("IsdsCredentialsError");
      expect(renderings(corrupt)).not.toContain(pki.clientPassphrase);
    }),
  );

  it.live("sends HTTP Basic credentials on the password route and never exposes the password", () =>
    Effect.gen(function* () {
      const server = yield* httpsServer(pki.server, (received, res) =>
        received.body === "deny" ? respond(401, "<html>Unauthorized</html>")(received, res) : respond(200, okBody)(received, res),
      );
      const config = passwordConfig(server.port);
      const transport = yield* makeTransport(config);

      const response = yield* transport.send(request("search"));
      expect(response.httpStatus).toBe(200);
      expect(server.requests[0]?.url).toBe("/DS/df");
      expect(server.requests[0]?.headers.authorization).toBe(
        `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
      );

      const denied = yield* Effect.flip(transport.send(request("search", "deny")));
      expect(denied).toMatchObject({ _tag: "IsdsAuthError", httpStatus: 401 });
      expect(renderings(denied)).not.toContain(password);
      expect(JSON.stringify(config)).not.toContain(password);
      expect(String(config.credentials)).not.toContain(password);

      const badUsername = yield* Effect.flip(
        makeTransport(
          passwordConfig(server.port, {
            credentials: IsdsCredentials.Password({ username: "box:user", password: Redacted.make(password) }),
          }),
        ),
      );
      expect(badUsername._tag).toBe("IsdsCredentialsError");
      expect(renderings(badUsername)).not.toContain(password);
    }),
  );

  it.live("maps HTTP statuses: 401/403 auth, 503 maintenance, 500 fault body, others HTTP errors", () =>
    Effect.gen(function* () {
      const server = yield* httpsServer({ ...pki.server, clientCa: pki.caCert }, (received, res) => {
        switch (received.body) {
          case "401":
            return respond(401, "<html>401</html>", { "Content-Type": "text/html" })(received, res);
          case "403":
            return respond(403, "<html>403</html>", { "Content-Type": "text/html" })(received, res);
          case "503":
            return respond(503, "maintenance", { "Retry-After": "120" })(received, res);
          case "503-bare":
            return respond(503, "maintenance")(received, res);
          case "404":
            return respond(404, "<html>404</html>", { "Content-Type": "text/html" })(received, res);
          case "500":
            return respond(500, faultBody)(received, res);
          default:
            return respond(418, "")(received, res);
        }
      });
      const transport = yield* makeTransport(certificateConfig(server.port));
      const fail = (body: string) => Effect.flip(transport.send(request("operations", body)));

      expect(yield* fail("401")).toMatchObject({ _tag: "IsdsAuthError", httpStatus: 401, service: "operations" });
      expect(yield* fail("403")).toMatchObject({ _tag: "IsdsAuthError", httpStatus: 403 });
      expect(yield* fail("503")).toMatchObject({ _tag: "IsdsMaintenanceError", retryAfter: "120" });
      const bare = yield* fail("503-bare");
      expect(bare._tag).toBe("IsdsMaintenanceError");
      expect(bare).not.toHaveProperty("retryAfter", expect.anything());
      expect(yield* fail("404")).toMatchObject({ _tag: "IsdsHttpError", httpStatus: 404, contentType: "text/html" });
      expect(yield* fail("teapot")).toMatchObject({ _tag: "IsdsHttpError", httpStatus: 418 });

      const fault = yield* transport.send(request("operations", "500"));
      expect(fault).toEqual({ httpStatus: 500, contentType: "text/xml; charset=utf-8", body: faultBody });
    }),
  );

  it.live("times out with requestSent=true once the request reached the server", () =>
    Effect.gen(function* () {
      const server = yield* httpsServer({ ...pki.server, clientCa: pki.caCert }, never);
      const transport = yield* makeTransport(certificateConfig(server.port, { requestTimeout: Duration.millis(1000) }));

      const error = yield* Effect.flip(transport.send(request()));

      expect(error).toMatchObject({ _tag: "IsdsTimeoutError", requestSent: true, timeoutMillis: 1000 });
      expect(server.requests.map((received) => received.body)).toEqual([envelope]);
    }),
  );

  it.live("times out with requestSent=false when the TLS handshake never completes", () =>
    Effect.gen(function* () {
      const server = yield* silentTcpServer();
      const transport = yield* makeTransport(certificateConfig(server.port, { requestTimeout: Duration.millis(500) }));

      const error = yield* Effect.flip(transport.send(request()));

      expect(error).toMatchObject({ _tag: "IsdsTimeoutError", requestSent: false, timeoutMillis: 500 });
      yield* server.connectionClosed;
    }),
  );

  it.live("fails with ResponseTooLarge over the cap, streamed or declared, and accepts a body at the cap", () =>
    Effect.gen(function* () {
      const cap = 1024;
      const server = yield* httpsServer({ ...pki.server, clientCa: pki.caCert }, (received, res) => {
        if (received.body === "streamed") {
          res.writeHead(200, { "Content-Type": "text/xml" });
          for (let index = 0; index < 8; index++) {
            res.write("x".repeat(512));
          }
          res.end();
        } else if (received.body === "declared") {
          respond(200, "x".repeat(4096))(received, res);
        } else {
          respond(200, "x".repeat(cap))(received, res);
        }
      });
      const transport = yield* makeTransport(certificateConfig(server.port, { maxResponseBytes: cap }));

      const streamed = yield* Effect.flip(transport.send(request("info", "streamed")));
      expect(streamed).toMatchObject({ _tag: "IsdsTransportError", reason: "ResponseTooLarge" });
      const declared = yield* Effect.flip(transport.send(request("info", "declared")));
      expect(declared).toMatchObject({ _tag: "IsdsTransportError", reason: "ResponseTooLarge" });
      const atCap = yield* transport.send(request("info", "at-cap"));
      expect(atCap.body).toHaveLength(cap);
    }),
  );

  it.live("destroys the request when the calling fiber is interrupted", () =>
    Effect.gen(function* () {
      const server = yield* httpsServer({ ...pki.server, clientCa: pki.caCert }, never);
      const transport = yield* makeTransport(certificateConfig(server.port));

      const fiber = yield* Effect.forkChild(transport.send(request()));
      yield* server.firstRequest;
      yield* Fiber.interrupt(fiber);

      yield* server.connectionClosed;
    }),
  );

  it.live("fails with reason Connection when nothing listens", () =>
    Effect.gen(function* () {
      const port = yield* silentTcpServer().pipe(Effect.map((server) => server.port), Effect.scoped);
      const transport = yield* makeTransport(certificateConfig(port));

      const error = yield* Effect.flip(transport.send(request()));

      expect(error).toMatchObject({ _tag: "IsdsTransportError", reason: "Connection" });
    }),
  );

  it.live("rejects a base URL that isn't https", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeTransport(certificateConfig(443, { baseUrl: "http://127.0.0.1:8080/cert" })));
      expect(error).toMatchObject({ _tag: "IsdsConfigError" });
    }),
  );
});
