import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { IsdsTimeoutError } from "../../src/isds/errors.js";
import { callIsds, type IsdsOperation } from "../../src/isds/soap.js";
import { xmlElement } from "../../src/isds/xml.js";
import { XsBoolean, XsDateTime, XsInteger, xmlList } from "../../src/isds/xsd.js";
import { dbStatus, dmStatus, fakeTransport, ok, serverError, soapFault, soapResponse } from "./fake-transport.js";

const Probe = Schema.Struct({
  items: Schema.optional(xmlList("n", XsInteger)),
  flag: Schema.optional(XsBoolean),
  at: Schema.optional(XsDateTime),
});

const probe = (overrides: Partial<IsdsOperation<typeof Probe.Type>> = {}): IsdsOperation<typeof Probe.Type> => ({
  service: "info",
  operation: "Probe",
  request: xmlElement("Probe", [xmlElement("dmID", "1")]),
  response: Probe,
  repeating: new Set(["n"]),
  status: "dm",
  ...overrides,
});

const call = <A>(operation: IsdsOperation<A>, reply: Parameters<typeof fakeTransport>[0]) => {
  const transport = fakeTransport(reply);
  return callIsds(operation).pipe(
    Effect.provide(transport.layer),
    Effect.map((result) => ({ ...result, requests: transport.requests })),
  );
};

describe("callIsds", () => {
  it.effect("wraps the request in a SOAP 1.1 envelope with the ISDS default namespace", () =>
    Effect.gen(function* () {
      const { requests } = yield* call(probe(), ok(soapResponse("Probe", dmStatus("0000"))));
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.service, "info");
      assert.strictEqual(requests[0]?.operation, "Probe");
      assert.strictEqual(
        requests[0]?.envelope,
        `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Probe xmlns="http://isds.czechpoint.cz/v20"><dmID>1</dmID></Probe></soap:Body></soap:Envelope>`,
      );
    }),
  );

  it.effect("decodes the response content and returns the status", () =>
    Effect.gen(function* () {
      const { response, status } = yield* call(
        probe(),
        ok(soapResponse("Probe", `<items><n>7</n></items><flag>1</flag><at>2026-01-02T10:00:00.123+01:00</at>${dmStatus("0000")}`)),
      );
      assert.deepStrictEqual(response.items, [7]);
      assert.strictEqual(response.flag, true);
      assert.strictEqual(response.at === undefined ? undefined : DateTime.toEpochMillis(response.at), Date.UTC(2026, 0, 2, 9, 0, 0, 123));
      assert.deepStrictEqual(status, { code: "0000", message: "Provedeno úspěšně." });
    }),
  );

  it.effect("decodes an empty or nil list container as an empty array", () =>
    Effect.gen(function* () {
      const empty = yield* call(probe(), ok(soapResponse("Probe", `<items/>${dmStatus("0000")}`)));
      assert.deepStrictEqual(empty.response.items, []);
      const nil = yield* call(
        probe(),
        ok(
          soapResponse(
            "Probe",
            `<items xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>${dmStatus("0000")}`,
          ),
        ),
      );
      assert.isUndefined(nil.response.items);
    }),
  );

  it.effect("fails with IsdsSoapFault on a fault in HTTP 500 or 200", () =>
    Effect.gen(function* () {
      for (const reply of [serverError(soapFault("SOAP-ENV:Server", "Boom")), ok(soapFault("Client", "Bad"))]) {
        const error = yield* Effect.flip(call(probe(), reply));
        assert.strictEqual(error._tag, "IsdsSoapFault");
        if (error._tag === "IsdsSoapFault") {
          assert.strictEqual(error.httpStatus, reply.httpStatus);
          assert.include(["SOAP-ENV:Server", "Client"], error.faultCode);
        }
      }
    }),
  );

  it.effect("fails with IsdsInvalidResponse on HTTP 500 without a fault", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(call(probe(), serverError(soapResponse("Probe", dmStatus("0000")))));
      assert.strictEqual(error._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("fails with IsdsStatusError on a non-success dmStatusCode, classified", () =>
    Effect.gen(function* () {
      const cases = [
        ["1222", "NotDelivered"],
        ["3022", "Blocked"],
        ["3008", "Transient"],
        ["1214", "AttachmentRejected"],
        ["9999", "Other"],
      ] as const;
      for (const [code, classification] of cases) {
        // A failing status comes without the payload, so the payload schema must not run.
        const error = yield* Effect.flip(call(probe(), ok(soapResponse("Probe", `<flag>bogus</flag>${dmStatus(code)}`))));
        assert.strictEqual(error._tag, "IsdsStatusError");
        if (error._tag === "IsdsStatusError") {
          assert.strictEqual(error.code, code);
          assert.strictEqual(error.statusKind, "dm");
          assert.strictEqual(error.classification, classification);
          assert.strictEqual(error.retryable, classification === "Transient");
        }
      }
    }),
  );

  it.effect("accepts the operation's extra success codes", () =>
    Effect.gen(function* () {
      const { status } = yield* call(probe({ successCodes: new Set(["0002"]) }), ok(soapResponse("Probe", dmStatus("0002", "Nic"))));
      assert.deepStrictEqual(status, { code: "0002", message: "Nic" });
    }),
  );

  it.effect("checks dbStatus for db operations and classifies 5001 as BoxNotFound", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(call(probe({ status: "db" }), ok(soapResponse("Probe", dbStatus("5001")))));
      assert.strictEqual(error._tag, "IsdsStatusError");
      if (error._tag === "IsdsStatusError") {
        assert.strictEqual(error.statusKind, "db");
        assert.strictEqual(error.classification, "BoxNotFound");
      }
      const missing = yield* Effect.flip(call(probe({ status: "db" }), ok(soapResponse("Probe", dmStatus("0000")))));
      assert.strictEqual(missing._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("fails with IsdsInvalidResponse on malformed XML, a non-SOAP body, or a schema mismatch", () =>
    Effect.gen(function* () {
      const replies = [
        ok("<SOAP-ENV:Envelope><SOAP-ENV:Body><ProbeResponse>"),
        ok("<html><body>Maintenance</body></html>"),
        ok(soapResponse("Other", dmStatus("0000"))),
        ok(soapResponse("Probe", `<flag>maybe</flag>${dmStatus("0000")}`)),
        ok(soapResponse("Probe", `<items><n>x</n></items>${dmStatus("0000")}`)),
        ok(soapResponse("Probe", "")),
      ];
      for (const reply of replies) {
        const error = yield* Effect.flip(call(probe(), reply));
        assert.strictEqual(error._tag, "IsdsInvalidResponse", reply.body);
      }
    }),
  );

  it.effect("fails with IsdsInvalidRequest, sending nothing, when request text holds a control character", () =>
    Effect.gen(function* () {
      const transport = fakeTransport(ok(soapResponse("Probe", dmStatus("0000"))));
      const error = yield* Effect.flip(
        callIsds(probe({ request: xmlElement("Probe", [xmlElement("dmAnnotation", "a\u0001b")]) })).pipe(
          Effect.provide(transport.layer),
        ),
      );
      assert.strictEqual(error._tag, "IsdsInvalidRequest");
      assert.strictEqual(transport.requests.length, 0);
    }),
  );

  it.effect("passes IsdsTimeoutError from the transport through unchanged", () =>
    Effect.gen(function* () {
      const timeout = new IsdsTimeoutError({ service: "info", operation: "Probe", timeoutMillis: 1000, requestSent: true });
      const error = yield* Effect.flip(call(probe(), () => Effect.fail(timeout)));
      assert.strictEqual(error, timeout);
    }),
  );
});
