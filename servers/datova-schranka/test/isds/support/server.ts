import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { TLSSocket } from "node:tls";
import { Deferred, Effect, Exit } from "effect";
import type { KeyPair } from "./pki.js";

export interface ReceivedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** Whether the server's TLS layer verified the client certificate against its CA. */
  readonly clientAuthorized: boolean;
  /** The verified client certificate's subject CN, if one was presented. */
  readonly clientCommonName: string | undefined;
}

/** Answers a request once its whole body has arrived; may also leave it unanswered. */
export type Handler = (request: ReceivedRequest, res: ServerResponse) => void;

export interface TestServer {
  readonly port: number;
  readonly requests: ReadonlyArray<ReceivedRequest>;
  /** Completes with the first request whose body has fully arrived. */
  readonly firstRequest: Effect.Effect<ReceivedRequest>;
  /** Completes once a connection the server accepted has closed. */
  readonly connectionClosed: Effect.Effect<void>;
}

export interface ServerOptions extends KeyPair {
  /** When set, the server requires a client certificate issued by this CA. */
  readonly clientCa?: string;
}

const listen = (server: net.Server): Effect.Effect<number> =>
  Effect.callback<number>((resume) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

const close = (server: net.Server, sockets: Set<net.Socket>): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close(() => resume(Effect.void));
  });

const trackSockets = (server: net.Server, closed: Deferred.Deferred<void>): Set<net.Socket> => {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      Deferred.doneUnsafe(closed, Exit.void);
    });
  });
  return sockets;
};

/** A local HTTPS server on 127.0.0.1, closed with the test's scope. */
export const httpsServer = Effect.fn("httpsServer")(function* (options: ServerOptions, handler: Handler) {
  const requests: Array<ReceivedRequest> = [];
  const first = yield* Deferred.make<ReceivedRequest>();
  const closed = yield* Deferred.make<void>();
  const server = https.createServer({
    key: options.key,
    cert: options.cert,
    ...(options.clientCa === undefined ? {} : { ca: options.clientCa, requestCert: true, rejectUnauthorized: true }),
  });
  const sockets = trackSockets(server, closed);
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const socket = req.socket as TLSSocket;
      const peer = socket.getPeerCertificate();
      const commonName = peer.subject?.CN;
      const received: ReceivedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        clientAuthorized: socket.authorized,
        clientCommonName: typeof commonName === "string" ? commonName : undefined,
      };
      requests.push(received);
      Deferred.doneUnsafe(first, Exit.succeed(received));
      handler(received, res);
    });
  });
  const port = yield* Effect.acquireRelease(listen(server), () => close(server, sockets));
  return {
    port,
    requests,
    firstRequest: Deferred.await(first),
    connectionClosed: Deferred.await(closed),
  } satisfies TestServer;
});

/** Accepts TCP connections and never answers, so a TLS handshake never completes. */
export const silentTcpServer = Effect.fn("silentTcpServer")(function* () {
  const closed = yield* Deferred.make<void>();
  const server = net.createServer((socket) => socket.resume());
  const sockets = trackSockets(server, closed);
  const port = yield* Effect.acquireRelease(listen(server), () => close(server, sockets));
  return { port, connectionClosed: Deferred.await(closed) };
});
