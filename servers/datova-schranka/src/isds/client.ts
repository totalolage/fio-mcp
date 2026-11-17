import { Context, Effect, Layer } from "effect";
import { createMessage } from "./create-message.js";
import { checkDataBox, findDataBoxes, getOwnerInfo } from "./databox.js";
import {
  downloadMessage,
  downloadMessageEnvelope,
  downloadSignedMessage,
  getDeliveryInfo,
  ping,
} from "./message-downloads.js";
import { getMessageStateChanges, listReceivedMessagesAndDeliver, listSentMessages } from "./message-lists.js";
import { reconcileSentMessage } from "./reconcile.js";
import { IsdsTransport } from "./transport.js";

/**
 * Every ISDS operation, each needing only an `IsdsTransport`. See each function's doc comment
 * for the operation's semantics; above all, `listReceivedMessagesAndDeliver` LEGALLY DELIVERS
 * the box's eligible received messages.
 */
const operations = {
  ping,
  getOwnerInfo,
  findDataBoxes,
  checkDataBox,
  listReceivedMessagesAndDeliver,
  listSentMessages,
  getMessageStateChanges,
  downloadMessageEnvelope,
  downloadMessage,
  downloadSignedMessage,
  getDeliveryInfo,
  createMessage,
  reconcileSentMessage,
};

type Operations = typeof operations;

/** An operation with its transport already provided. */
type Provided<F> = F extends (...args: infer Args) => Effect.Effect<infer A, infer E, IsdsTransport>
  ? (...args: Args) => Effect.Effect<A, E>
  : never;

export type IsdsClientShape = { readonly [K in keyof Operations]: Provided<Operations[K]> };

const provided =
  <Args extends ReadonlyArray<unknown>, A, E>(
    transport: IsdsTransport["Service"],
    operation: (...args: Args) => Effect.Effect<A, E, IsdsTransport>,
  ) =>
  (...args: Args): Effect.Effect<A, E> =>
    Effect.provideService(operation(...args), IsdsTransport, transport);

const make = Effect.gen(function* () {
  const transport = yield* IsdsTransport;
  return IsdsClient.of({
    ping: provided(transport, ping),
    getOwnerInfo: provided(transport, getOwnerInfo),
    findDataBoxes: provided(transport, findDataBoxes),
    checkDataBox: provided(transport, checkDataBox),
    listReceivedMessagesAndDeliver: provided(transport, listReceivedMessagesAndDeliver),
    listSentMessages: provided(transport, listSentMessages),
    getMessageStateChanges: provided(transport, getMessageStateChanges),
    downloadMessageEnvelope: provided(transport, downloadMessageEnvelope),
    downloadMessage: provided(transport, downloadMessage),
    downloadSignedMessage: provided(transport, downloadSignedMessage),
    getDeliveryInfo: provided(transport, getDeliveryInfo),
    createMessage: provided(transport, createMessage),
    reconcileSentMessage: provided(transport, reconcileSentMessage),
  });
});

/**
 * A type-safe client for one ISDS data box (datová schránka). Failures are typed: transport
 * failures (`IsdsTransportFailure`, incl. `IsdsTimeoutError`), `IsdsSoapFault`,
 * `IsdsStatusError` (non-success dmStatus/dbStatus, classified), `IsdsInvalidResponse`, and
 * `IsdsInvalidRequest` / `IsdsMessageTooLarge` for input rejected before anything is sent.
 */
export class IsdsClient extends Context.Service<IsdsClient, IsdsClientShape>()("datova-schranka/IsdsClient") {
  /** The client over whatever `IsdsTransport` is provided. */
  static readonly Default = Layer.effect(IsdsClient, make);
}
