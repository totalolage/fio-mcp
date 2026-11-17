import type { Flash } from "@mcps/core/admin/pages.js";
import { ADMIN_PATH } from "@mcps/core/admin/sessions.js";
import { type AdminActionContext, type AdminFormFile, type AdminTab, field, file } from "@mcps/core/admin/tab.js";
import { Redactor } from "@mcps/core/redaction.js";
import { Effect, Redacted } from "effect";
import { type AuditFinalOutcome, AuditLog } from "../domain/audit-log.js";
import { type Box, BoxRegistry } from "../domain/boxes.js";
import { DomainConfig } from "../domain/config.js";
import { IsdsCredentials } from "../isds/config.js";
import {
  ADD_PATH,
  boxesBody,
  CREDENTIALS_PATH,
  ownerSummary,
  RELABEL_PATH,
  REMOVE_PATH,
  TEST_PATH,
} from "./boxes-pages.js";

/**
 * The admin UI's Boxes tab at /admin (first in the nav): lists the stored
 * data boxes (and those of another ISDS environment, which are not
 * loaded), adds one by signing in to ISDS (username and password, or a
 * PKCS#12 upload and its passphrase), renames, replaces the credentials of
 * (same dbID only), tests and removes one. Replacing credentials and
 * removing ask for the second factor when one is configured.
 *
 * Every action writes exactly one audit row (actor admin, action box_*,
 * outcome ok, refused or error). Secrets are never rendered, never part of
 * a message or an audit detail, and every message passes the Redactor,
 * which the registry gives each secret before it signs in.
 */

/** The largest add or replace form: a PKCS#12 file and a few fields (design R6). */
export const BOX_FORM_MAX_BYTES = 256 * 1024;

/** Audit actions of the tab. */
export const BOX_AUDIT_ACTIONS = {
  add: "box_add",
  relabel: "box_relabel",
  replaceCredentials: "box_replace_credentials",
  test: "box_test",
  remove: "box_remove",
} as const;

/** Errors that leave nothing changed because the request was refused (conflict, validation); others are failures. */
const REFUSALS: ReadonlySet<string> = new Set([
  "InvalidIdentifier",
  "BoxLabelTaken",
  "BoxAlreadyAdded",
  "BoxEnvironmentMismatch",
  "BoxSecretTooShort",
  "BoxIdentityMismatch",
  "BoxNotFound",
]);

/** The longest message taken from an error (ISDS fault strings can be long). */
const MESSAGE_LIMIT = 300;

/** What an action did: the message to show and the audit row to write. */
interface Outcome {
  readonly flash: Flash;
  readonly outcome: AuditFinalOutcome;
  readonly boxId?: string | undefined;
  readonly detail: Record<string, unknown>;
}

const refused = (text: string, boxId?: string, detail: Record<string, unknown> = {}): Outcome => ({
  flash: { kind: "error", text },
  outcome: "refused",
  boxId,
  detail: { ...detail, reason: text },
});

/** The credentials a form names, or the message to refuse it with. Nothing secret is in the message. */
const credentialsOf = (form: URLSearchParams, files: ReadonlyArray<AdminFormFile>): IsdsCredentials | string => {
  switch (field(form, "auth")) {
    case "password": {
      const username = (field(form, "username") ?? "").trim();
      const password = field(form, "password") ?? "";
      if (username === "") return "Enter the ISDS username.";
      if (password === "") return "Enter the ISDS password.";
      return IsdsCredentials.Password({ username, password: Redacted.make(password) });
    }
    case "certificate": {
      const certificate = file(files, "certificate");
      const passphrase = field(form, "passphrase") ?? "";
      if (certificate === undefined || Redacted.value(certificate.content).length === 0) {
        return "Choose the PKCS#12 certificate file (.p12 or .pfx).";
      }
      if (passphrase === "") return "Enter the certificate passphrase.";
      return IsdsCredentials.SystemCertificate({
        pkcs12: Redacted.value(certificate.content),
        passphrase: Redacted.make(passphrase),
      });
    }
    default:
      return "Choose how the box signs in: username and password, or a certificate.";
  }
};

const boxInfo = (box: Box) => ({ label: box.label, dbId: box.dbId, authKind: box.authKind });

export const boxesTab: Effect.Effect<AdminTab, never, BoxRegistry | AuditLog | Redactor | DomainConfig> = Effect.gen(function* () {
  const registry = yield* BoxRegistry;
  const audit = yield* AuditLog;
  const redactor = yield* Redactor;
  const { environment } = yield* DomainConfig;

  /** A safe one-line message of an error: redacted, bounded. */
  const messageOf = (error: { readonly message: string }) => {
    const text = redactor.redact(error.message).replace(/\s+/g, " ").trim();
    return Array.from(text).length > MESSAGE_LIMIT ? `${Array.from(text).slice(0, MESSAGE_LIMIT).join("")}…` : text;
  };

  /** The outcome of a failed registry call: refused or error, with its safe message. */
  const failed =
    (prefix: string, boxId?: string, detail: Record<string, unknown> = {}) =>
    (error: { readonly _tag: string; readonly message: string }): Outcome => {
      const message = messageOf(error);
      return {
        flash: { kind: "error", text: `${prefix}${message}` },
        outcome: REFUSALS.has(error._tag) ? "refused" : "error",
        boxId,
        detail: { ...detail, error: error._tag, reason: message },
      };
    };

  /** Writes the outcome's audit row and returns its message. */
  const audited = (action: string, perform: Effect.Effect<Outcome>) =>
    Effect.flatMap(perform, (done) =>
      audit
        .record({ actor: { kind: "admin" }, action, boxId: done.boxId, outcome: done.outcome, detail: done.detail })
        .pipe(
          Effect.as(done.flash),
          Effect.catch((error) =>
            Effect.succeed<Flash>({
              kind: "error",
              text: `${done.flash.text} The audit row could not be written: ${messageOf(error)}`,
            }),
          ),
        ),
    );

  /** Undefined when the second factor passed, else the refusal. */
  const secondFactorRefusal = (context: AdminActionContext, nothing: string) =>
    Effect.map(context.checkSecondFactor, (factor): string | undefined => {
      switch (factor._tag) {
        case "Accepted":
          return undefined;
        case "Rejected":
          return `The authentication code is missing or wrong. ${nothing}`;
        case "Throttled":
          return `Too many failed attempts. Try again in ${factor.retryAfterSeconds} s. ${nothing}`;
        case "Unavailable":
          return `The authentication code could not be checked. ${nothing}`;
      }
    });

  const render = (csrf: string, request: { readonly secondFactor: boolean }) =>
    Effect.all([registry.list, registry.skipped]).pipe(
      Effect.map(([boxes, skipped]) => ({ body: boxesBody(csrf, request.secondFactor, environment, boxes, skipped) })),
    );

  const add = Effect.fnUntraced(function* (form: URLSearchParams, context: AdminActionContext) {
    const label = field(form, "label") ?? "";
    const detail = { label: label.trim(), authKind: field(form, "auth") };
    const credentials = credentialsOf(form, context.files);
    if (typeof credentials === "string") return refused(`Not added: ${credentials}`, undefined, detail);
    return yield* registry.add({ label, environment, credentials }).pipe(
      Effect.map(
        (box): Outcome => ({
          flash: {
            kind: "ok",
            text: `Added “${box.label}”: data box ${box.dbId}, ${ownerSummary(box.owner)}. Clients reach it once they are authorized for it.`,
          },
          outcome: "ok",
          boxId: box.id,
          detail: { ...boxInfo(box), boxType: box.boxType },
        }),
      ),
      Effect.catch((error) => Effect.succeed(failed("Not added: ", undefined, detail)(error))),
    );
  });

  const relabel = Effect.fnUntraced(function* (form: URLSearchParams) {
    const boxId = field(form, "box") ?? "";
    const before = yield* Effect.option(registry.get(boxId));
    return yield* registry.relabel(boxId, field(form, "label") ?? "").pipe(
      Effect.map(
        (box): Outcome => ({
          flash: { kind: "ok", text: `Renamed “${before._tag === "Some" ? before.value.label : box.dbId}” to “${box.label}”.` },
          outcome: "ok",
          boxId,
          detail: { from: before._tag === "Some" ? before.value.label : undefined, to: box.label, dbId: box.dbId },
        }),
      ),
      Effect.catch((error) => Effect.succeed(failed("Not renamed: ", boxId)(error))),
    );
  });

  const replaceCredentials = Effect.fnUntraced(function* (form: URLSearchParams, context: AdminActionContext) {
    const boxId = field(form, "box") ?? "";
    const detail = { authKind: field(form, "auth") };
    const credentials = credentialsOf(form, context.files);
    if (typeof credentials === "string") return refused(`Not replaced: ${credentials}`, boxId, detail);
    const factor = yield* secondFactorRefusal(context, "The credentials were not replaced.");
    if (factor !== undefined) return refused(factor, boxId, { ...detail, secondFactor: "failed" });
    return yield* registry.replaceCredentials(boxId, credentials).pipe(
      Effect.map(
        (box): Outcome => ({
          flash: { kind: "ok", text: `Replaced the credentials of “${box.label}” (data box ${box.dbId}).` },
          outcome: "ok",
          boxId,
          detail: boxInfo(box),
        }),
      ),
      Effect.catch((error) => Effect.succeed(failed("Not replaced: ", boxId, detail)(error))),
    );
  });

  const testConnection = Effect.fnUntraced(function* (form: URLSearchParams) {
    const boxId = field(form, "box") ?? "";
    return yield* registry.testConnection(boxId).pipe(
      Effect.flatMap(() => registry.get(boxId)),
      Effect.map(
        (box): Outcome => ({
          flash: { kind: "ok", text: `ISDS accepted the credentials of “${box.label}” (data box ${box.dbId}).` },
          outcome: "ok",
          boxId,
          detail: { label: box.label, dbId: box.dbId },
        }),
      ),
      Effect.catch((error) => Effect.succeed(failed("Connection test failed: ", boxId)(error))),
    );
  });

  const remove = Effect.fnUntraced(function* (form: URLSearchParams, context: AdminActionContext) {
    const boxId = field(form, "box") ?? "";
    if (field(form, "confirm") !== "yes") return refused("Tick the box to confirm the removal.", boxId);
    const factor = yield* secondFactorRefusal(context, "Nothing was removed.");
    if (factor !== undefined) return refused(factor, boxId, { secondFactor: "failed" });
    return yield* registry.remove(boxId).pipe(
      Effect.map(
        ({ box, expiredFilings }): Outcome => ({
          flash: {
            kind: "ok",
            text: `Removed “${box.label}” (data box ${box.dbId}). ${
              expiredFilings === 1 ? "1 filing waiting for approval expired." : `${expiredFilings} filings waiting for approval expired.`
            }`,
          },
          outcome: "ok",
          boxId,
          detail: { label: box.label, dbId: box.dbId, expiredFilings },
        }),
      ),
      Effect.catch((error) => Effect.succeed(failed("Not removed: ", boxId)(error))),
    );
  });

  const multipart = { maxBytes: BOX_FORM_MAX_BYTES, multipart: true } as const;
  return {
    id: "boxes",
    label: "Data boxes",
    path: ADMIN_PATH,
    nav: "first",
    render,
    actions: [
      { path: ADD_PATH, form: multipart, run: (form, context) => audited(BOX_AUDIT_ACTIONS.add, add(form, context)) },
      { path: RELABEL_PATH, run: (form) => audited(BOX_AUDIT_ACTIONS.relabel, relabel(form)) },
      {
        path: CREDENTIALS_PATH,
        form: multipart,
        run: (form, context) => audited(BOX_AUDIT_ACTIONS.replaceCredentials, replaceCredentials(form, context)),
      },
      { path: TEST_PATH, run: (form) => audited(BOX_AUDIT_ACTIONS.test, testConnection(form)) },
      { path: REMOVE_PATH, run: (form, context) => audited(BOX_AUDIT_ACTIONS.remove, remove(form, context)) },
    ],
  } satisfies AdminTab;
});
