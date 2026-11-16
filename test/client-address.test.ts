import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, Option } from "effect";
import { HttpServerRequest } from "effect/http";
import {
  clientAddress,
  makeUntrustedForwardingCheck,
  parseTrustedProxy,
  UNTRUSTED_FORWARDING_WARNING,
} from "../src/transport/client-address.js";

const networks = (...entries: Array<string>) => entries.flatMap((entry) => parseTrustedProxy(entry) ?? []);

const request = (peer: string | undefined, forwardedFor?: string) => {
  const web = HttpServerRequest.fromWeb(
    new Request("http://fio.example.test/login", {
      headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    }),
  );
  return peer === undefined ? web : web.modify({ remoteAddress: Option.some(peer) });
};

describe("clientAddress", () => {
  const traefik = networks("172.18.0.0/16", "fd00::1");

  it("uses the socket peer when no proxy is trusted, ignoring forwarding headers", () => {
    assert.strictEqual(clientAddress(request("172.18.0.2", "203.0.113.9"), []), "172.18.0.2");
    assert.strictEqual(clientAddress(request("203.0.113.9", "198.51.100.7"), traefik), "203.0.113.9");
  });

  it("takes the rightmost untrusted X-Forwarded-For address from a trusted proxy", () => {
    assert.strictEqual(clientAddress(request("172.18.0.2", "203.0.113.9"), traefik), "203.0.113.9");
    // Entries left of the address the proxy appended are the client's own and ignored.
    assert.strictEqual(clientAddress(request("172.18.0.2", "198.51.100.7, 10.0.0.1, 203.0.113.9"), traefik), "203.0.113.9");
    // Chained trusted proxies are skipped.
    assert.strictEqual(clientAddress(request("172.18.0.2", "203.0.113.9, 172.18.0.7"), traefik), "203.0.113.9");
    assert.strictEqual(clientAddress(request("[fd00::1]", "2001:db8::5"), traefik), "2001:db8::5");
  });

  it("falls back to the peer when the header is missing or unparseable", () => {
    assert.strictEqual(clientAddress(request("172.18.0.2"), traefik), "172.18.0.2");
    assert.strictEqual(clientAddress(request("172.18.0.2", "unknown"), traefik), "172.18.0.2");
    assert.strictEqual(clientAddress(request("172.18.0.2", "203.0.113.9, junk"), traefik), "172.18.0.2");
    assert.strictEqual(clientAddress(request(undefined, "203.0.113.9"), traefik), "unknown");
  });

  it("uses the leftmost address when every hop is trusted, and normalizes IPv4-mapped peers", () => {
    assert.strictEqual(clientAddress(request("172.18.0.2", "172.18.0.9, 172.18.0.7"), traefik), "172.18.0.9");
    assert.strictEqual(clientAddress(request("::ffff:172.18.0.2", "203.0.113.9"), traefik), "203.0.113.9");
    assert.strictEqual(clientAddress(request("::ffff:203.0.113.9"), traefik), "203.0.113.9");
  });
});

describe("parseTrustedProxy", () => {
  it("accepts addresses and CIDR networks, and nothing else", () => {
    assert.isDefined(parseTrustedProxy("172.18.0.1"));
    assert.isDefined(parseTrustedProxy("172.18.0.0/16"));
    assert.isDefined(parseTrustedProxy("fd00::/8"));
    assert.isDefined(parseTrustedProxy("::1"));
    assert.isUndefined(parseTrustedProxy("traefik"));
    assert.isUndefined(parseTrustedProxy("172.18.0.0/40"));
    assert.isUndefined(parseTrustedProxy("172.18.0.1:80/16"));
    // Peers are matched as IPv4; a mapped network would never match.
    assert.isUndefined(parseTrustedProxy("::ffff:172.18.0.0/112"));
    assert.isDefined(parseTrustedProxy("::ffff:172.18.0.2"));
  });
});

describe("makeUntrustedForwardingCheck", () => {
  const traefik = networks("172.18.0.0/16");
  /** Runs the requests through one check with a test logger; returns the log lines. */
  const logsOf = (requests: ReadonlyArray<HttpServerRequest.HttpServerRequest>) =>
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const capture = Logger.make<unknown, void>((entry) => {
        logs.push(Logger.formatLogFmt.log(entry));
      });
      const check = makeUntrustedForwardingCheck(traefik);
      yield* Effect.forEach(requests, check, { discard: true }).pipe(Effect.provide(Logger.layer([capture])));
      return logs;
    });

  it.effect("warns exactly once, without addresses, about X-Forwarded-For from untrusted peers", () =>
    Effect.gen(function* () {
      const logs = yield* logsOf([
        request("203.0.113.9"),
        request("203.0.113.9", "198.51.100.7"),
        request("203.0.113.10", "198.51.100.8"),
        request("192.0.2.1", "198.51.100.9, 10.0.0.1"),
      ]);
      assert.strictEqual(logs.length, 1);
      assert.include(logs[0], UNTRUSTED_FORWARDING_WARNING);
      assert.notMatch(logs[0] ?? "", /203\.0\.113|198\.51\.100|192\.0\.2/);
    }),
  );

  it.effect("stays silent for trusted proxies and requests without X-Forwarded-For", () =>
    Effect.gen(function* () {
      const logs = yield* logsOf([
        request("172.18.0.2", "203.0.113.9"),
        request("172.18.0.3", "198.51.100.7, 203.0.113.9"),
        request("203.0.113.9"),
      ]);
      assert.deepStrictEqual(logs, []);
    }),
  );
});
