/**
 * ISDS SOAP replies for the send operations, as the real IsdsClient parses them, and the
 * transport failures a fake transport callback can return for CreateMessage.
 */
import { Effect } from "effect";
import {
  IsdsAuthError,
  IsdsHttpError,
  IsdsMaintenanceError,
  IsdsTimeoutError,
  IsdsTransportError,
  type IsdsTransportFailure,
} from "../../../../src/isds/errors.js";
import type { IsdsSoapResponse } from "../../../../src/isds/transport.js";
import { dbStatus, dmStatus, ok, serverError, soapFault, soapResponse } from "../../../isds/fake-transport.js";
import { RECIPIENT_DB_ID } from "./requests.js";

/** CheckDataBox answering `dbState` (1 = can receive) with status 0000. */
export const checkDataBoxReply = (dbState: number): IsdsSoapResponse =>
  ok(soapResponse("CheckDataBox", `<dbState>${dbState}</dbState>${dbStatus("0000")}`));

/** CheckDataBox refused with a non-0000 db status (5001: no such box). */
export const checkDataBoxStatusError = (code = "5001"): IsdsSoapResponse =>
  ok(soapResponse("CheckDataBox", dbStatus(code)));

/** CreateMessage accepted with `dmID`. */
export const createMessageReply = (dmID: string): IsdsSoapResponse =>
  ok(soapResponse("CreateMessage", `<dmID>${dmID}</dmID>${dmStatus("0000")}`));

/** CreateMessage refused by ISDS with a dm status (1214: attachment rejected). */
export const createMessageStatusError = (code = "1214"): IsdsSoapResponse =>
  ok(soapResponse("CreateMessage", dmStatus(code)));

/** A SOAP fault (IsdsSoapFault). */
export const soapFaultReply = (): IsdsSoapResponse => serverError(soapFault("SOAP-ENV:Server", "Internal error"));

/** Status 0000 without a dmID (IsdsInvalidResponse). */
export const createMessageWithoutDmId = (): IsdsSoapResponse => ok(soapResponse("CreateMessage", dmStatus("0000")));

/** The fields a reconcile matches a sent message on; defaults are the sendRequest() fixture's. */
export interface SentRow {
  readonly dmID: string;
  readonly recipient?: string;
  readonly annotation?: string;
  readonly senderRefNumber?: string;
}

const sentRecord = (row: SentRow, ordinal: number): string =>
  `<dmRecord><dmOrdinal>${ordinal}</dmOrdinal><dmID>${row.dmID}</dmID><dmSenderType>10</dmSenderType>` +
  `<dbIDRecipient>${row.recipient ?? RECIPIENT_DB_ID}</dbIDRecipient>` +
  `<dmAnnotation>${row.annotation ?? "Invoice 2026/11"}</dmAnnotation>` +
  `<dmSenderRefNumber>${row.senderRefNumber ?? "REF-1"}</dmSenderRefNumber><dmMessageStatus>2</dmMessageStatus></dmRecord>`;

/** GetListOfSentMessages listing `rows` (none: NotFound; one matching: Found; two matching: Ambiguous). */
export const sentMessagesReply = (rows: ReadonlyArray<SentRow>): IsdsSoapResponse =>
  ok(
    soapResponse(
      "GetListOfSentMessages",
      `<dmRecords>${rows.map((row, index) => sentRecord(row, index + 1)).join("")}</dmRecords>${dmStatus("0000")}`,
    ),
  );

const at = (service: "operations" | "search", operation: string) => ({ service, operation });
const createMessage = at("operations", "CreateMessage");

/** Every CreateMessage transport failure after which ISDS may have the message, by name. */
export const ambiguousTransportFailures: Readonly<Record<string, () => IsdsTransportFailure>> = {
  "IsdsTimeoutError (requestSent)": () =>
    new IsdsTimeoutError({ ...createMessage, timeoutMillis: 30_000, requestSent: true }),
  "IsdsTransportError Tls": () => new IsdsTransportError({ ...createMessage, reason: "Tls", detail: "test" }),
  "IsdsTransportError Connection": () => new IsdsTransportError({ ...createMessage, reason: "Connection", detail: "test" }),
  "IsdsTransportError ResponseTooLarge": () =>
    new IsdsTransportError({ ...createMessage, reason: "ResponseTooLarge", detail: "test" }),
  IsdsHttpError: () => new IsdsHttpError({ ...createMessage, httpStatus: 502, contentType: "text/html" }),
  IsdsAuthError: () => new IsdsAuthError({ ...createMessage, httpStatus: 401 }),
  IsdsMaintenanceError: () => new IsdsMaintenanceError({ ...createMessage, retryAfter: "60" }),
};

/** IsdsTimeoutError before the request went out (a proven pre-send failure). */
export const timeoutBeforeSend = (): IsdsTransportFailure =>
  new IsdsTimeoutError({ ...createMessage, timeoutMillis: 30_000, requestSent: false });

/** A CheckDataBox transport failure (the recipient could not be checked). */
export const checkDataBoxUnreachable = (): IsdsTransportFailure =>
  new IsdsTransportError({ ...at("search", "CheckDataBox"), reason: "Connection", detail: "test" });

/** A reply callback failing with `failure`. */
export const failWith =
  (failure: () => IsdsTransportFailure) =>
  (): Effect.Effect<IsdsSoapResponse, IsdsTransportFailure> =>
    Effect.fail(failure());
