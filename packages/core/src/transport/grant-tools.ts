import { Effect, Predicate } from "effect";
import { type McpProtocol, McpSchema } from "effect/ai";
import { coveredResources, holdsScopes, isListed, type ToolPolicyShape } from "../mcp/grants.js";
import type { Resource } from "../resources.js";
import { CurrentPrincipal, type Principal } from "./principal.js";
import type { ServerInfo } from "./server-info.js";

/**
 * HTTP `tools/list` follows the session's grant: a tool is listed only when
 * the grant holds its scopes (ToolPolicy), the resource parameter's enum
 * names only the granted resources, and a tool that takes a resource is left
 * out when the grant covers none. This is discovery only. The app's tool
 * handlers still check every call (src/mcp/grants.ts), so a hidden tool
 * called by name is denied by the app, not answered as "unknown tool".
 *
 * Effect registers tools once per server, not per session, and offers no
 * `tools/list` hook. Each protocol adapter installs its handlers on a core
 * it receives untyped; the wrapped adapter hands them a core whose
 * `tools.list` filters by the request's CurrentPrincipal. That API is
 * unstable: the core's shape is checked when the handlers install (server
 * start), and the app's tests cover every protocol version it offers.
 *
 * HTTP only: its guard provides the principal per request. stdio provides it
 * at tool registration, so `tools/list` there would see the default
 * principal (no access).
 */

type ToolList = ReadonlyArray<McpSchema.Tool>;

interface ToolsCore {
  readonly tools: { readonly list: (profile: unknown) => Effect.Effect<ToolList> };
}

const isToolsCore = (core: unknown): core is ToolsCore =>
  Predicate.hasProperty(core, "tools") &&
  Predicate.hasProperty(core.tools, "list") &&
  Predicate.isFunction(core.tools.list);

/**
 * The tools `principal` may see, with resource enums narrowed to its
 * resources. A tool the policy does not list (ToolPolicyShape.listed) is
 * hidden from every grant; it stays registered, so a call by name gets the
 * app's denial like any other hidden tool.
 */
export function grantedTools(
  tools: ToolList,
  principal: Principal,
  resources: ReadonlyArray<Resource>,
  policy: ToolPolicyShape,
): ToolList {
  const granted = new Set(coveredResources(principal, resources).map((resource) => resource.label));
  const parameter = policy.resourceParameter;
  return tools.flatMap((tool) => {
    if (!isListed(policy, tool.name)) return [];
    if (!holdsScopes(principal, policy.scopes(tool.name))) return [];
    if (policy.resourceless(tool.name)) return [tool];
    if (granted.size === 0) return [];
    const resource = tool.inputSchema.properties?.[parameter];
    // With one configured resource there is no parameter to narrow.
    if (resource === undefined) return [tool];
    // Some other shape (a schema-generation change) could list ungranted labels.
    if (!Predicate.isObject(resource) || !Array.isArray(resource.enum)) return [];
    const labels = resource.enum.filter((label) => granted.has(label));
    if (labels.length === 0) return [];
    const properties = { ...tool.inputSchema.properties, [parameter]: { ...resource, enum: labels } };
    return [McpSchema.Tool.make({ ...tool, inputSchema: { ...tool.inputSchema, properties } })];
  });
}

/** The resources as of this request; they may change at runtime. */
type CurrentResources = Effect.Effect<ReadonlyArray<Resource>>;

const grantCore = (core: ToolsCore, resources: CurrentResources, policy: ToolPolicyShape): ToolsCore => ({
  ...core,
  tools: {
    ...core.tools,
    list: (profile) =>
      Effect.flatMap(core.tools.list(profile), (tools) =>
        Effect.flatMap(CurrentPrincipal, (principal) =>
          Effect.map(resources, (list) => grantedTools(tools, principal, list, policy)),
        ),
      ),
  },
});

// ProtocolAdapter types the handlers' requirements `unknown`; McpServer
// provides them where it installs the handlers.
const handlersOf = (adapter: McpProtocol.ProtocolAdapter) => adapter as McpProtocol.AnyProtocolAdapter<string, never>;

const grantAdapter = (
  adapter: McpProtocol.ProtocolAdapter,
  resources: CurrentResources,
  policy: ToolPolicyShape,
): McpProtocol.ProtocolAdapter => ({
  ...adapter,
  installHandlers: (core, lifecycle, target) => {
    // Only the stateful revisions are offered and tested. Stateless ones read
    // `tools.list` inside `tools/call` too (header validation).
    if (adapter.runtime._tag !== "Stateful") {
      return Effect.die(`grant-tools: MCP ${adapter.protocolVersion} is stateless; grant filtering is tested on stateful revisions only`);
    }
    if (!isToolsCore(core)) {
      return Effect.die(`grant-tools: the MCP core for ${adapter.protocolVersion} no longer has tools.list; update src/transport/grant-tools.ts`);
    }
    return handlersOf(adapter).installHandlers(grantCore(core, resources, policy), lifecycle, target);
  },
});

/** `protocols` with each adapter's `tools/list` following the request's grant. */
export function grantProtocols(
  protocols: ServerInfo["protocols"],
  resources: CurrentResources,
  policy: ToolPolicyShape,
): ServerInfo["protocols"] {
  const [first, ...rest] = protocols;
  return [grantAdapter(first, resources, policy), ...rest.map((adapter) => grantAdapter(adapter, resources, policy))];
}
