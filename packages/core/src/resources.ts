import { Context, type Effect, type Stream } from "effect";

/**
 * Something the server's tools act on and a grant can cover, such as a bank
 * account or a data box. The app maps its own records onto resources.
 *
 * `id` is the opaque grant key: grants store it, the principal carries it,
 * and authorization compares it. It should survive renames. `label` is the
 * name clients see: tool parameters take it, and the consent page shows it.
 * Labels must be unique among the current resources, since a tool call and
 * the consent form select a resource by its label.
 */
export interface Resource {
  readonly id: string;
  readonly label: string;
}

export interface ResourcesShape {
  /**
   * The resources right now; they may change at runtime. Yields the same
   * array value until they change (ToolListChangesLive compares by identity).
   */
  readonly list: Effect.Effect<ReadonlyArray<Resource>>;
  /** The current list (the value `list` yields), then every new one. */
  readonly changes: Stream.Stream<ReadonlyArray<Resource>>;
}

/** The app's resources, as the HTTP transport, tool registration and OAuth consent see them. */
export class Resources extends Context.Service<Resources, ResourcesShape>()("mcps/Resources") {}
