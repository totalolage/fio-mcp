import { createHash } from "node:crypto";
import type { ConsentRenderer, ResourceWords } from "@mcps/core/oauth/app.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import { READ_SCOPE, SEND_SCOPE } from "../mcp/tool-group.js";

/**
 * The version of the delivery-consent wording below. Bump it with every
 * change of the wording (test/oauth/consent-wording.test.ts pins each
 * version to its wording's sha256), so every grant records the exact text
 * its owner accepted.
 */
export const DELIVERY_CONSENT_VERSION = "2026-11-17.1";

/** What the owner accepts before a grant may include isds:read: Czech first, English below. */
export const DELIVERY_CONSENT_WORDING = {
  cs: "Beru na vědomí, že výpis přijatých zpráv přes tento server okamžitě doručí každou dosud nedoručenou zprávu ve vybraných datových schránkách. Doručením začínají běžet zákonné lhůty. Filtry ani limity výpisu neomezují, co se doručí: výpis doručí všechny zprávy, které lze doručit. Kdo chce doručení odložit, nesmí tento server používat.",
  en: "I understand that listing received messages through this server immediately delivers every not-yet-delivered message in the selected data boxes. Delivery starts legal deadlines. Filters and limits do not restrict what is delivered: a listing delivers every message that can be delivered. Anyone who intends to delay delivery must not use this server.",
} as const;

/** Hex sha256 of the wording (Czech, a newline, English), recorded with every read consent. */
export const DELIVERY_CONSENT_SHA256 = createHash("sha256")
  .update(`${DELIVERY_CONSENT_WORDING.cs}\n${DELIVERY_CONSENT_WORDING.en}`, "utf8")
  .digest("hex");

/** The consent form's delivery-consent checkbox; ticked it posts "on". */
export const DELIVERY_CONSENT_FIELD = "isds_delivery_consent";

/** The consent form's scope checkboxes (ScopeCatalogue.granted reads them back). */
export const SCOPE_FIELD = "scope";

/** How the consent page names the data boxes a grant covers; each checkbox posts the box's label. */
export const BOX_WORDS: ResourceWords = {
  legend: "Data boxes",
  field: "box",
  plural: "data boxes",
  changed: "The data boxes changed while this page was open. Review the selection and approve again.",
  none: "No data boxes are configured yet. Add one at /admin first.",
  noneSelected: "Select at least one data box.",
};

const SCOPE_LABELS: ReadonlyArray<readonly [scope: string, id: string, label: string]> = [
  [
    READ_SCOPE,
    "scope-read",
    "Read: list received and sent messages, download messages and attachments, delivery info and state changes; search data boxes",
  ],
  [SEND_SCOPE, "scope-send", "Send messages from the selected data boxes, within the recipient rules set at /admin"],
];

/**
 * The Permissions fieldset: a checkbox per scope, ticked as requested (or as
 * the owner's own submission had it when the page is shown again), then the
 * delivery consent, never pre-ticked unless the owner ticked it. It has no
 * `required`: it is required only while read is ticked, which the server
 * checks (GrantSettings.fromConsent).
 */
const permissions = (requested: ReadonlyArray<string>, posted?: URLSearchParams): string => {
  const ticked = (scope: string) =>
    posted === undefined ? requested.includes(scope) : posted.getAll(SCOPE_FIELD).includes(scope);
  const scopes = SCOPE_LABELS.map(
    ([scope, id, label]) =>
      `<input type="checkbox" id="${id}" name="${SCOPE_FIELD}" value="${escapeHtml(scope)}"${ticked(scope) ? " checked" : ""}> <label class="inline" for="${id}">${escapeHtml(label)} (<code>${escapeHtml(scope)}</code>)</label><br>`,
  ).join("\n");
  const consented = posted?.getAll(DELIVERY_CONSENT_FIELD).includes("on") === true;
  return `${scopes}
<fieldset class="delivery-consent"><legend>Delivery consent (required for read access)</legend>
<input type="checkbox" id="delivery-consent" name="${DELIVERY_CONSENT_FIELD}" value="on"${consented ? " checked" : ""}> <label class="inline" for="delivery-consent">Souhlasím / I agree (version <code>${escapeHtml(DELIVERY_CONSENT_VERSION)}</code>):</label>
<p lang="cs">${escapeHtml(DELIVERY_CONSENT_WORDING.cs)}</p>
<p lang="en">${escapeHtml(DELIVERY_CONSENT_WORDING.en)}</p>
</fieldset>`;
};

/** The login and consent pages' words and fields for data boxes. */
export const CONSENT_RENDERER: ConsentRenderer = {
  tools: "your data box (ISDS) tools",
  permissions,
  style: "label.inline{display:inline}.delivery-consent p{margin:.5rem 0}",
  resources: BOX_WORDS,
};
