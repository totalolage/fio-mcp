import { Context, type Effect } from "effect";
import type { Account } from "./accounts.js";
import type { FioRequestError } from "./errors.js";
import type { Priority } from "./rate-limiter.js";
import type { NormalizedStatement } from "./statement.js";

/** Movement export formats (PDF §5). */
export const MOVEMENT_FORMATS = ["csv", "gpc", "html", "json", "ofx", "xml"] as const;
/** Official statements additionally support MT940 (`sta`) and ČBA/SBA XML. PDF is binary and not exposed. */
export const STATEMENT_FORMATS = [...MOVEMENT_FORMATS, "sta", "cba_xml", "sba_xml"] as const;
export const MERCHANT_FORMATS = ["xml", "csv"] as const;

export type MovementFormat = (typeof MOVEMENT_FORMATS)[number];
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];
export type MerchantFormat = (typeof MERCHANT_FORMATS)[number];

/**
 * FIO's REST API for one account at a time. Every call goes through the
 * account token's rate limiter (interactive priority unless stated), applies
 * the request timeout, and maps every failure to a tagged error. JSON
 * statements are normalized, and their header is passed to
 * `Accounts.learn`.
 */
export interface FioApiShape {
  /** GET /periods/{token}/{from}/{to}/transactions.json. Never moves the download marker. */
  readonly periods: (
    account: Account,
    from: string,
    to: string,
    priority?: Priority,
  ) => Effect.Effect<NormalizedStatement, FioRequestError>;
  /** GET /periods/{token}/{from}/{to}/transactions.{format}, raw text. */
  readonly periodsRaw: (
    account: Account,
    from: string,
    to: string,
    format: MovementFormat,
  ) => Effect.Effect<string, FioRequestError>;
  /** GET /by-id/{token}/{year}/{id}/transactions.json */
  readonly statement: (account: Account, year: number, id: number) => Effect.Effect<NormalizedStatement, FioRequestError>;
  /** GET /by-id/{token}/{year}/{id}/transactions.{format}, raw text. */
  readonly statementRaw: (
    account: Account,
    year: number,
    id: number,
    format: StatementFormat,
  ) => Effect.Effect<string, FioRequestError>;
  /** GET /last/{token}/transactions.json. Advances the server-side marker when non-empty. */
  readonly last: (account: Account) => Effect.Effect<NormalizedStatement, FioRequestError>;
  /** GET /set-last-id/{token}/{id}/ */
  readonly setLastId: (account: Account, id: number) => Effect.Effect<void, FioRequestError>;
  /** GET /set-last-date/{token}/{date}/ */
  readonly setLastDate: (account: Account, date: string) => Effect.Effect<void, FioRequestError>;
  /** GET /lastStatement/{token}/statement, raw text (the format is undocumented). */
  readonly lastStatement: (account: Account) => Effect.Effect<string, FioRequestError>;
  /** GET /merchant/{token}/{from}/{to}/transactions.{format}, raw text. */
  readonly merchantRaw: (
    account: Account,
    from: string,
    to: string,
    format: MerchantFormat,
  ) => Effect.Effect<string, FioRequestError>;
  /**
   * POST /import/ with a Fio XML file (type=xml, lng=en). Creates a payment
   * batch on success. Returns the raw XML response. HTTP 500 and 401/403
   * map to PermissionDenied.
   */
  readonly importXml: (account: Account, xml: string) => Effect.Effect<string, FioRequestError>;
}

export class FioApi extends Context.Service<FioApi, FioApiShape>()("fio-mcp/FioApi") {}
