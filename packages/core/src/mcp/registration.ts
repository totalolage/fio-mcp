import { Effect, Layer, type Scope, Stream } from "effect";
import { type McpSchema, McpServer } from "effect/ai";
import { type Resource, Resources } from "../resources.js";

/**
 * Tool registration that follows the app's resources. Tool schemas name the
 * resources by label (an enum parameter, or no parameter with one
 * resource), and resources may change at runtime.
 *
 * `register(labels)` registers a toolkit built for those labels. It runs once
 * at startup and again whenever the labels change; McpServer replaces tools
 * by name, so calls decode against the new schema, and it sends
 * `notifications/tools/list_changed` to every live session. A change that
 * keeps the labels (a resource id replaced) changes what each grant may see
 * (transport/grant-tools.ts), so ToolListChangesLive sends
 * `list_changed` too.
 */

const labels = (list: ReadonlyArray<Resource>) => list.map((resource) => resource.label);

const sameLabels = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((label, index) => label === b[index]);

/**
 * Registers tools for the current resource labels, and again when they
 * change. `failureLog` is the error line logged when re-registering fails.
 */
export const toolsForResources = <E, R>(
  register: (resourceLabels: ReadonlyArray<string>) => Effect.Effect<void, E, R>,
  failureLog: string,
): Layer.Layer<never, E, Exclude<Exclude<R, Scope.Scope>, McpServer.McpServer | McpSchema.McpServerClient> | Resources> =>
  Layer.effectDiscard(
    Effect.gen(function* (): Effect.fn.Return<void, E, R | Resources | Scope.Scope> {
      const resources = yield* Resources;
      let registered = labels(yield* resources.list);
      yield* register(registered);
      const follow = Effect.fnUntraced(function* (list: ReadonlyArray<Resource>) {
        const next = labels(list);
        if (sameLabels(next, registered)) return;
        registered = next;
        yield* register(next);
      });
      yield* Effect.forkScoped(
        Stream.runForEach(resources.changes, (list) =>
          follow(list).pipe(Effect.catchCause((cause) => Effect.logError(failureLog, cause))),
        ),
      );
    }),
  ).pipe(Layer.provide(McpServer.McpServer.layer));

/**
 * Tells every live session to list the tools again whenever the resource
 * list changes. A change is a new list value: the Resources service hands
 * out the same list value until its resources change.
 */
export const ToolListChangesLive: Layer.Layer<never, never, Resources> = Layer.effectDiscard(
  Effect.gen(function* () {
    const resources = yield* Resources;
    const server = yield* McpServer.McpServer;
    let previous = yield* resources.list;
    const notify = (list: ReadonlyArray<Resource>): Effect.Effect<void> => {
      if (list === previous) return Effect.void;
      previous = list;
      return Effect.ignore(server.notifications["notifications/tools/list_changed"]({}));
    };
    yield* Effect.forkScoped(Stream.runForEach(resources.changes, notify));
  }),
).pipe(Layer.provide(McpServer.McpServer.layer));

