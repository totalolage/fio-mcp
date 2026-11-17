import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { type Box, BoxCredentialsUnreadable, BoxRegistry } from "../../../src/domain/boxes.js";
import { BoxNotFound } from "../../../src/domain/errors.js";
import type { IsdsCredentials } from "../../../src/isds/config.js";

/** A stored box and what `credentials` answers for it; `unreadable` fails with BoxCredentialsUnreadable. */
export interface FakeBoxEntry {
  readonly box: Box;
  readonly credentials: IsdsCredentials | "unreadable";
}

export const fakeBox = (id: string, dbId = "abc2def"): Box => ({
  id,
  dbId,
  label: `Box ${id}`,
  environment: "production",
  boxType: undefined,
  authKind: "password",
  owner: { dbID: dbId },
  createdAt: 0,
  updatedAt: 0,
});

interface FakeState {
  readonly entries: ReadonlyArray<FakeBoxEntry>;
  readonly boxes: ReadonlyArray<Box>;
}

const stateOf = (entries: ReadonlyArray<FakeBoxEntry>): FakeState => ({
  entries,
  boxes: entries.map((entry) => entry.box),
});

/**
 * An in-memory BoxRegistry for what BoxClients reads: list, changes, get, credentials.
 * `credentials` returns the very IsdsCredentials object stored for the box until
 * `replaceCredentials` swaps it, as the real registry does. The registry's own mutators die;
 * tests change the boxes through `remove`, `replaceCredentials` and `add` on the result.
 */
export const makeFakeBoxRegistry = Effect.fn("makeFakeBoxRegistry")(function* (
  initial: ReadonlyArray<FakeBoxEntry>,
) {
  const state = yield* SubscriptionRef.make(stateOf(initial));
  const find = (boxId: string) =>
    SubscriptionRef.get(state).pipe(
      Effect.flatMap(({ entries }) => {
        const entry = entries.find((candidate) => candidate.box.id === boxId);
        return entry === undefined ? Effect.fail(new BoxNotFound({ boxId })) : Effect.succeed(entry);
      }),
    );
  const unused = (name: string) => () => Effect.die(`fake BoxRegistry.${name} is not used by these tests`);

  const service = BoxRegistry.of({
    list: SubscriptionRef.get(state).pipe(Effect.map(({ boxes }) => boxes)),
    changes: SubscriptionRef.changes(state).pipe(Stream.map(({ boxes }) => boxes)),
    skipped: Effect.succeed([]),
    get: (boxId) => find(boxId).pipe(Effect.map(({ box }) => box)),
    credentials: (boxId) =>
      find(boxId).pipe(
        Effect.flatMap(({ credentials }) =>
          credentials === "unreadable"
            ? Effect.fail(new BoxCredentialsUnreadable({ boxId }))
            : Effect.succeed(credentials),
        ),
      ),
    add: unused("add"),
    relabel: unused("relabel"),
    replaceCredentials: unused("replaceCredentials"),
    testConnection: unused("testConnection"),
    remove: unused("remove"),
  });

  const edit = (f: (entries: ReadonlyArray<FakeBoxEntry>) => ReadonlyArray<FakeBoxEntry>) =>
    SubscriptionRef.update(state, ({ entries }) => stateOf(f(entries)));

  return {
    layer: Layer.succeed(BoxRegistry, service),
    add: (entry: FakeBoxEntry) => edit((entries) => [...entries, entry]),
    remove: (boxId: string) => edit((entries) => entries.filter((entry) => entry.box.id !== boxId)),
    replaceCredentials: (boxId: string, credentials: IsdsCredentials | "unreadable") =>
      edit((entries) => entries.map((entry) => (entry.box.id === boxId ? { ...entry, credentials } : entry))),
  };
});
