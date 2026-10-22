import { FioApiError, errorForStatus } from "./errors.js";
import type { TokenRateLimiter } from "./rate-limiter.js";
import { redact } from "./redact.js";

export type FetchFn = typeof fetch;

/** Movement export formats (PDF §5). */
export const MOVEMENT_FORMATS = ["csv", "gpc", "html", "json", "ofx", "xml"] as const;
/** Official statements additionally support MT940 (`sta`) and ČBA/SBA XML. PDF is binary and omitted. */
export const STATEMENT_FORMATS = [...MOVEMENT_FORMATS, "sta", "cba_xml", "sba_xml"] as const;
export const MERCHANT_FORMATS = ["xml", "csv"] as const;

export type MovementFormat = (typeof MOVEMENT_FORMATS)[number];
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];
export type MerchantFormat = (typeof MERCHANT_FORMATS)[number];

export interface FioClientOptions {
  baseUrl: string;
  token: string;
  limiter: TokenRateLimiter;
  requestTimeoutMs: number;
  fetch?: FetchFn;
}

const EXCERPT_LENGTH = 300;

/**
 * Thin HTTP client for one FIO token. Every request goes through the token's
 * rate limiter. Errors carry only redacted text.
 */
export class FioClient {
  private readonly fetchFn: FetchFn;

  constructor(private readonly options: FioClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  /** GET /periods/{token}/{from}/{to}/transactions.{format} */
  periods(from: string, to: string, format: MovementFormat, signal?: AbortSignal): Promise<string> {
    return this.get(["periods", this.token, from, to, `transactions.${format}`], signal);
  }

  /** GET /by-id/{token}/{year}/{id}/transactions.{format} */
  statement(year: number, id: number, format: StatementFormat, signal?: AbortSignal): Promise<string> {
    return this.get(["by-id", this.token, String(year), String(id), `transactions.${format}`], signal);
  }

  /** GET /last/{token}/transactions.{format}. Advances the server-side marker when non-empty. */
  last(format: MovementFormat, signal?: AbortSignal): Promise<string> {
    return this.get(["last", this.token, `transactions.${format}`], signal);
  }

  /** GET /set-last-id/{token}/{id}/ */
  setLastId(id: number, signal?: AbortSignal): Promise<string> {
    return this.get(["set-last-id", this.token, String(id), ""], signal);
  }

  /** GET /set-last-date/{token}/{date}/ */
  setLastDate(date: string, signal?: AbortSignal): Promise<string> {
    return this.get(["set-last-date", this.token, date, ""], signal);
  }

  /** GET /lastStatement/{token}/statement */
  lastStatement(signal?: AbortSignal): Promise<string> {
    return this.get(["lastStatement", this.token, "statement"], signal);
  }

  /** GET /merchant/{token}/{from}/{to}/transactions.{format} */
  merchant(from: string, to: string, format: MerchantFormat, signal?: AbortSignal): Promise<string> {
    return this.get(["merchant", this.token, from, to, `transactions.${format}`], signal);
  }

  /** POST /import/ with a Fio XML file. Creates a payment batch on success. */
  importXml(xml: string, signal?: AbortSignal): Promise<string> {
    return this.options.limiter.run(async () => {
      const form = new FormData();
      form.set("type", "xml");
      form.set("token", this.token);
      form.set("lng", "en");
      form.set("file", new Blob([xml], { type: "application/xml" }), "orders.xml");
      return this.send(`${this.options.baseUrl}/import/`, { method: "POST", body: form }, signal);
    }, signal);
  }

  private get token(): string {
    return encodeURIComponent(this.options.token);
  }

  private get(segments: string[], signal?: AbortSignal): Promise<string> {
    const url = `${this.options.baseUrl}/${segments.join("/")}`;
    return this.options.limiter.run(() => this.send(url, { method: "GET" }, signal), signal);
  }

  private async send(url: string, init: RequestInit, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchFn(url, { ...init, signal: combined });
    } catch (error) {
      if (timeout.aborted) {
        throw new FioApiError("timeout", `FIO did not respond within ${this.options.requestTimeoutMs} ms.`);
      }
      if (signal?.aborted) throw new FioApiError("network", "Request cancelled by the client.");
      const message = error instanceof Error ? `${error.message}${causeText(error)}` : String(error);
      throw new FioApiError("network", redact(`Could not reach FIO: ${message}`));
    }
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new FioApiError("network", "Connection to FIO dropped while reading the response.", response.status);
    }
    if (!response.ok) {
      throw errorForStatus(response.status, excerpt(body));
    }
    return body;
  }
}

function causeText(error: Error): string {
  const cause = error.cause;
  if (cause instanceof Error) return ` (${cause.message})`;
  return "";
}

/** Short, single-line, token-free excerpt of a response body for error messages. */
export function excerpt(body: string): string {
  // Redact before stripping tags and again before truncating: a cut could leave
  // a token prefix that redact no longer recognizes.
  const text = redact(
    redact(body)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
}
