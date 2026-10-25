import { Effect, Layer, type Scope, Stream } from "effect";
import { type McpSchema, McpServer } from "effect/ai";
import { type Account, Accounts } from "../accounts.js";

/**
 * Tool registration that follows the configured accounts. Tool schemas name
 * the accounts (`account` enum, or no parameter with one account), and in
 * HTTP mode with OAuth accounts change at runtime (/admin).
 *
 * `register(names)` registers a toolkit built for those names. It runs once
 * at startup and again whenever the names change; McpServer replaces tools
 * by name, so calls decode against the new schema, and it sends
 * `notifications/tools/list_changed` to every live session. A change that
 * keeps the names (a token replaced) changes what each grant may see
 * (src/transport/grant-tools.ts), so it sends `list_changed` too.
 */

const names = (list: ReadonlyArray<Account>) => list.map((account) => account.name);

const sameNames = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((name, index) => name === b[index]);

export const toolsForAccounts = <E, R>(
  register: (accountNames: ReadonlyArray<string>) => Effect.Effect<void, E, R>,
): Layer.Layer<never, E, Exclude<Exclude<R, Scope.Scope>, McpServer.McpServer | McpSchema.McpServerClient> | Accounts> =>
  Layer.effectDiscard(
    Effect.gen(function* (): Effect.fn.Return<void, E, R | Accounts | Scope.Scope> {
      const accounts = yield* Accounts;
      let registered = names(yield* accounts.list);
      yield* register(registered);
      const follow = Effect.fnUntraced(function* (list: ReadonlyArray<Account>) {
        const next = names(list);
        if (sameNames(next, registered)) return;
        registered = next;
        yield* register(next);
      });
      yield* Effect.forkScoped(
        Stream.runForEach(accounts.changes, (list) =>
          follow(list).pipe(Effect.catchCause((cause) => Effect.logError("mcp: could not update the tools after an account change", cause))),
        ),
      );
    }),
  ).pipe(Layer.provide(McpServer.McpServer.layer));

/** Tells every live session to list the tools again whenever the accounts change. */
export const ToolListChangesLive: Layer.Layer<never, never, Accounts> = Layer.effectDiscard(
  Effect.gen(function* () {
    const accounts = yield* Accounts;
    const server = yield* McpServer.McpServer;
    let previous = yield* accounts.list;
    const notify = (list: ReadonlyArray<Account>): Effect.Effect<void> => {
      if (list === previous) return Effect.void;
      previous = list;
      return Effect.ignore(server.notifications["notifications/tools/list_changed"]({}));
    };
    yield* Effect.forkScoped(Stream.runForEach(accounts.changes, notify));
  }),
).pipe(Layer.provide(McpServer.McpServer.layer));
