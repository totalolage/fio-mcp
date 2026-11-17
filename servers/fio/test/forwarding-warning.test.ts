import { assert, describe, it } from "@effect/vitest";
import { untrustedForwardingWarning } from "@mcps/core/transport/client-address.js";
import { TRUSTED_PROXIES_SETTING } from "../src/transport/auth.js";

describe("untrusted X-Forwarded-For warning", () => {
  it("names FIO_MCP_TRUSTED_PROXIES in the exact 617bb3e wording", () => {
    assert.strictEqual(
      untrustedForwardingWarning(TRUSTED_PROXIES_SETTING),
      "X-Forwarded-For received from an untrusted peer; set FIO_MCP_TRUSTED_PROXIES to the proxy's address.",
    );
  });
});
