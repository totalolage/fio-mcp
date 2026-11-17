import { Effect, Layer } from "effect";
import { BoxClients } from "../../../src/domain/box-clients.js";
import { BoxNotFound } from "../../../src/domain/errors.js";
import { IsdsClient } from "../../../src/isds/client.js";
import type { IsdsTransportFailure } from "../../../src/isds/errors.js";
import type { IsdsSoapRequest, IsdsSoapResponse } from "../../../src/isds/transport.js";
import { fakeTransport, ok } from "../../isds/fake-transport.js";

export type ReadReply = IsdsSoapResponse | ((request: IsdsSoapRequest) => Effect.Effect<IsdsSoapResponse, IsdsTransportFailure>);

/** Replies per SOAP operation name; an operation without one gets an empty body (IsdsInvalidResponse). */
export type ReadReplies = Readonly<Record<string, ReadReply>>;

/**
 * BoxClients whose `use` runs `f` with a real IsdsClient over a fake transport for `boxId`,
 * and fails BoxNotFound for any other id. Every request reaching the transport is logged
 * as `isds <operation>` in the shared `log` and kept in `requests`.
 */
export const readBoxClients = (boxId: string, replies: ReadReplies, log: Array<string>) => {
  const transport = fakeTransport((request) => {
    log.push(`isds ${request.operation}`);
    const reply = replies[request.operation] ?? ok("");
    return typeof reply === "function" ? reply(request) : Effect.succeed(reply);
  });
  const layer = Layer.effect(
    BoxClients,
    Effect.gen(function* () {
      const client = yield* IsdsClient;
      return BoxClients.of({
        use: (id, f) => (id === boxId ? f(client) : Effect.fail(new BoxNotFound({ boxId: id }))),
      });
    }),
  ).pipe(Layer.provide(IsdsClient.Default), Layer.provide(transport.layer));
  return { layer, requests: transport.requests };
};
