import { assert, describe, it } from "@effect/vitest";
import { isListed, ToolPolicy } from "@mcps/core/mcp/grants.js";
import { Effect } from "effect";
import { toolPolicy, toolPolicyLayer } from "../../src/mcp/policy.js";
import { READ_SCOPE, SEND_SCOPE, type ToolSpec } from "../../src/mcp/tool-group.js";

const SPECS: ReadonlyArray<ToolSpec> = [
  { name: "get_server_status", scopes: [READ_SCOPE], resourceless: true },
  { name: "get_message", scopes: [READ_SCOPE] },
  { name: "send_message", scopes: [SEND_SCOPE] },
];

describe("toolPolicy", () => {
  it("maps each spec to its scopes, box binding and listing", () => {
    const policy = toolPolicy(SPECS);
    assert.strictEqual(policy.resourceParameter, "box");
    assert.deepStrictEqual(policy.scopes("get_message"), [READ_SCOPE]);
    assert.deepStrictEqual(policy.scopes("send_message"), [SEND_SCOPE]);
    assert.isTrue(policy.resourceless("get_server_status"));
    assert.isFalse(policy.resourceless("get_message"));
    assert.isTrue(isListed(policy, "send_message"));
  });

  it("hides a tool without a spec", () => {
    const policy = toolPolicy(SPECS);
    assert.isFalse(isListed(policy, "unknown_tool"));
    assert.deepStrictEqual(policy.scopes("unknown_tool"), []);
    assert.isFalse(policy.resourceless("unknown_tool"));
  });

  it.effect("provides the policy as core's ToolPolicy service", () =>
    Effect.gen(function* () {
      const policy = yield* ToolPolicy;
      assert.deepStrictEqual(policy.scopes("get_message"), [READ_SCOPE]);
    }).pipe(Effect.provide(toolPolicyLayer(SPECS))),
  );
});
