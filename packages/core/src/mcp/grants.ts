import { Context, Effect, Layer } from "effect";
import type { Resource } from "../resources.js";
import { CurrentPrincipal, type Principal } from "../transport/principal.js";

/**
 * Grant checks against the caller's principal. The app owns its scope
 * catalogue, which scopes each tool needs, and the errors and messages a
 * denied call gets; core owns only the comparisons.
 *
 * A grant names resources by `Resource.id`, never by label: renaming a
 * resource keeps its grants.
 */

/** Whether a granted set ("all", or a list) includes `item`. */
const allows = (granted: "all" | ReadonlyArray<string>, item: string) => granted === "all" || granted.includes(item);

/** The scopes in `scopes` that `principal` does not hold. */
export const missingScopes = (principal: Principal, scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
  scopes.filter((scope) => !allows(principal.scopes, scope));

/** Whether `principal` holds every scope in `scopes`. */
export const holdsScopes = (principal: Principal, scopes: ReadonlyArray<string>): boolean =>
  scopes.every((scope) => allows(principal.scopes, scope));

/** Whether `principal`'s grant covers the resource with id `id`. */
export const coversResource = (principal: Principal, id: string): boolean => allows(principal.resources, id);

/** The resources in `list` that `principal`'s grant covers. */
export const coveredResources = <R extends Resource>(principal: Principal, list: ReadonlyArray<R>): ReadonlyArray<R> =>
  list.filter((resource) => coversResource(principal, resource.id));

/** Fails with `deny(missing)` unless the caller holds every scope in `scopes`. */
export const requireScopes = <E>(
  scopes: ReadonlyArray<string>,
  deny: (missing: ReadonlyArray<string>) => E,
): Effect.Effect<void, E> =>
  Effect.flatMap(CurrentPrincipal, (principal) => {
    const missing = missingScopes(principal, scopes);
    return missing.length > 0 ? Effect.fail(deny(missing)) : Effect.void;
  });

/** Fails with `deny()` unless the caller's grant covers the resource with id `id`. */
export const requireResource = <E>(id: string, deny: () => E): Effect.Effect<void, E> =>
  Effect.flatMap(CurrentPrincipal, (principal) => (coversResource(principal, id) ? Effect.void : Effect.fail(deny())));

/**
 * Which grant a tool needs, for listing tools per grant (HTTP `tools/list`,
 * transport/grant-tools.ts). Tool handlers still check each call.
 */
export interface ToolPolicyShape {
  /** The scopes a tool needs to be listed and called. */
  readonly scopes: (tool: string) => ReadonlyArray<string>;
  /** Whether a tool acts on no single resource. Every other tool takes one. */
  readonly resourceless: (tool: string) => boolean;
  /**
   * The input property naming the resource, an enum of resource labels.
   * A tool without it (one resource configured) takes no resource argument.
   */
  readonly resourceParameter: string;
  /**
   * Whether HTTP `tools/list` offers a tool at all (default: every tool). A
   * tool it hides is left out for every grant (transport/grant-tools.ts).
   * Hiding is discovery only: the app's handler must still refuse a call
   * to it by name.
   */
  readonly listed?: (tool: string) => boolean;
}

/** Whether `policy` lists `tool` (ToolPolicyShape.listed, default true). */
export const isListed = (policy: ToolPolicyShape, tool: string): boolean => policy.listed?.(tool) ?? true;

/** The app's tool policy. */
export class ToolPolicy extends Context.Service<ToolPolicy, ToolPolicyShape>()("mcps/ToolPolicy") {
  static readonly layer = (policy: ToolPolicyShape): Layer.Layer<ToolPolicy> => Layer.succeed(ToolPolicy, ToolPolicy.of(policy));
}
