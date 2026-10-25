import { Effect, Predicate } from "effect";
import { type McpProtocol, McpSchema } from "effect/ai";
import type { Account } from "../accounts.js";
import { ACCOUNTLESS_TOOLS, coveredAccounts, holdsScopes, toolScopes } from "../mcp/permissions.js";
import { CurrentPrincipal, type Principal } from "./principal.js";
import type { ServerInfo } from "./server-info.js";

/**
 * HTTP `tools/list` follows the session's grant: a tool is listed only when
 * the grant holds its scopes, the `account` enum names only the granted
 * accounts, and a tool that takes an account is left out when the grant
 * covers none. This is discovery only. Calls are still checked one by one
 * (src/mcp/permissions.ts), so a hidden tool called by name answers "You
 * don't have permissions to do that.", not "unknown tool".
 *
 * Effect registers tools once per server, not per session, and offers no
 * `tools/list` hook. Each protocol adapter installs its handlers on a core
 * it receives untyped; the wrapped adapter hands them a core whose
 * `tools.list` filters by the request's CurrentPrincipal. That API is
 * unstable: the core's shape is checked when the handlers install (server
 * start), and test/grant-tools.test.ts covers every offered protocol version.
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

/** The tools `principal` may see, with `account` enums narrowed to its accounts. */
export function grantedTools(tools: ToolList, principal: Principal, accounts: ReadonlyArray<Account>): ToolList {
  const granted = new Set(coveredAccounts(principal, accounts).map((account) => account.name));
  return tools.flatMap((tool) => {
    if (!holdsScopes(principal, toolScopes(tool.name))) return [];
    if (ACCOUNTLESS_TOOLS.has(tool.name)) return [tool];
    if (granted.size === 0) return [];
    const account = tool.inputSchema.properties?.account;
    // With one configured account there is no `account` parameter to narrow.
    if (account === undefined) return [tool];
    // Some other shape (a schema-generation change) could list ungranted names.
    if (!Predicate.isObject(account) || !Array.isArray(account.enum)) return [];
    const names = account.enum.filter((name) => granted.has(name));
    if (names.length === 0) return [];
    const properties = { ...tool.inputSchema.properties, account: { ...account, enum: names } };
    return [McpSchema.Tool.make({ ...tool, inputSchema: { ...tool.inputSchema, properties } })];
  });
}

/** The configured accounts as of this request; they change at runtime in HTTP mode with OAuth. */
type CurrentAccounts = Effect.Effect<ReadonlyArray<Account>>;

const grantCore = (core: ToolsCore, accounts: CurrentAccounts): ToolsCore => ({
  ...core,
  tools: {
    ...core.tools,
    list: (profile) =>
      Effect.flatMap(core.tools.list(profile), (tools) =>
        Effect.flatMap(CurrentPrincipal, (principal) => Effect.map(accounts, (list) => grantedTools(tools, principal, list))),
      ),
  },
});

// ProtocolAdapter types the handlers' requirements `unknown`; McpServer
// provides them where it installs the handlers.
const handlersOf = (adapter: McpProtocol.ProtocolAdapter) => adapter as McpProtocol.AnyProtocolAdapter<string, never>;

const grantAdapter = (adapter: McpProtocol.ProtocolAdapter, accounts: CurrentAccounts): McpProtocol.ProtocolAdapter => ({
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
    return handlersOf(adapter).installHandlers(grantCore(core, accounts), lifecycle, target);
  },
});

/** `protocols` with each adapter's `tools/list` following the request's grant. */
export function grantProtocols(protocols: ServerInfo["protocols"], accounts: CurrentAccounts): ServerInfo["protocols"] {
  const [first, ...rest] = protocols;
  return [grantAdapter(first, accounts), ...rest.map((adapter) => grantAdapter(adapter, accounts))];
}
