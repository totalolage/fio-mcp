import { csrfField, formatTime, hidden } from "@mcps/core/admin/pages.js";
import { escapeHtml } from "@mcps/core/oauth/pages.js";
import type { Box, SkippedBox } from "../domain/boxes.js";
import type { IsdsEnvironment } from "../isds/config.js";
import type { DataBoxOwnerInfo } from "../isds/databox.js";

/**
 * The HTML of the admin Boxes tab. Every stored value is escaped; no
 * credential (username, password, passphrase, certificate) is ever written
 * into a page, and secret inputs never carry a value.
 */

export const ADD_PATH = "/admin/boxes/add";
export const RELABEL_PATH = "/admin/boxes/relabel";
export const CREDENTIALS_PATH = "/admin/boxes/credentials";
export const TEST_PATH = "/admin/boxes/test";
export const REMOVE_PATH = "/admin/boxes/remove";

/** The owner as one line: firm or person, IČO, city. */
export const ownerSummary = (owner: DataBoxOwnerInfo): string => {
  const person = [owner.pnFirstName, owner.pnMiddleName, owner.pnLastName].filter((part) => part !== undefined && part !== "").join(" ");
  const name = owner.firmName !== undefined && owner.firmName !== "" ? owner.firmName : person;
  const parts = [name === "" ? "unnamed owner" : name];
  if (owner.ic !== undefined && owner.ic !== "") parts.push(`IČO ${owner.ic}`);
  if (owner.adCity !== undefined && owner.adCity !== "") parts.push(owner.adCity);
  return parts.join(", ");
};

const authLabel = (kind: Box["authKind"]) => (kind === "certificate" ? "System certificate" : "Username and password");

const totpField = (secondFactor: boolean) =>
  secondFactor
    ? `<label>Authenticator code <input type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label>`
    : "";

/** The sign-in fields of add and replace; nothing is pre-filled. */
const credentialFields = `<fieldset><legend>Sign-in</legend>
<label><input type="radio" name="auth" value="password" checked> Username and password</label>
<label><input type="radio" name="auth" value="certificate"> System certificate (PKCS#12)</label>
<label>ISDS username <input type="text" name="username" autocomplete="off" spellcheck="false"></label>
<label>ISDS password <input type="password" name="password" autocomplete="new-password"></label>
<label>Certificate file <input type="file" name="certificate" accept=".p12,.pfx,application/x-pkcs12"></label>
<label>Certificate passphrase <input type="password" name="passphrase" autocomplete="new-password"></label>
<span class="muted">Fill the username and password, or choose the certificate file and its passphrase. At least 8 characters.</span>
</fieldset>`;

const boxRow = (csrf: string, secondFactor: boolean, box: Box) => `<tr>
<td><strong>${escapeHtml(box.label)}</strong></td>
<td><code>${escapeHtml(box.dbId)}</code></td>
<td>${escapeHtml(ownerSummary(box.owner))}</td>
<td>${escapeHtml(box.boxType ?? "unknown")}</td>
<td>${authLabel(box.authKind)}</td>
<td>${escapeHtml(box.environment)}</td>
<td>${formatTime(box.createdAt)}<br><span class="muted">updated ${formatTime(box.updatedAt)}</span></td>
<td>
<form method="post" action="${TEST_PATH}">${csrfField(csrf)}${hidden("box", box.id)}<button type="submit">Test connection</button></form>
<details><summary>Rename</summary><form method="post" action="${RELABEL_PATH}">${csrfField(csrf)}${hidden("box", box.id)}
<label>New label <input type="text" name="label" value="${escapeHtml(box.label)}" maxlength="64" required></label>
<button type="submit">Rename</button><span class="muted">Connected clients keep access.</span></form></details>
<details><summary>Replace credentials</summary><form method="post" action="${CREDENTIALS_PATH}" enctype="multipart/form-data">${csrfField(csrf)}${hidden("box", box.id)}
${credentialFields}
${totpField(secondFactor)}
<button type="submit">Replace</button><span class="muted">The new credentials must sign in to data box ${escapeHtml(box.dbId)}. Connected clients keep access.</span></form></details>
<details><summary class="danger">Remove</summary><form method="post" action="${REMOVE_PATH}">${csrfField(csrf)}${hidden("box", box.id)}
<label><input type="checkbox" name="confirm" value="yes" required> Remove “${escapeHtml(box.label)}” and its stored credentials</label>
${totpField(secondFactor)}
<button type="submit">Remove</button><span class="muted">Filings waiting for approval expire. Audit rows stay. Adding the box again gives it a new id, so existing client authorizations do not regain it.</span></form></details>
</td>
</tr>`;

const skippedWarning = (environment: IsdsEnvironment, skipped: ReadonlyArray<SkippedBox>) =>
  skipped.length === 0
    ? ""
    : `<div class="error" role="alert"><p><strong>${skipped.length === 1 ? "One stored data box is" : `${skipped.length} stored data boxes are`} not loaded:</strong> ${skipped.length === 1 ? "it was" : "they were"} added under another ISDS environment than this server's (${escapeHtml(environment)}).</p>
<ul>${skipped.map((box) => `<li>${escapeHtml(box.label)} (<code>${escapeHtml(box.dbId)}</code>, ${escapeHtml(box.environment)})</li>`).join("")}</ul></div>`;

export const boxesBody = (
  csrf: string,
  secondFactor: boolean,
  environment: IsdsEnvironment,
  boxes: ReadonlyArray<Box>,
  skipped: ReadonlyArray<SkippedBox>,
) =>
  `<h1>Data boxes</h1>
<p class="muted">This server uses the ISDS ${escapeHtml(environment)} environment. Credentials are stored encrypted and never shown. Clients reach a box only after they are authorized for it.</p>
${skippedWarning(environment, skipped)}
${
  boxes.length === 0
    ? "<p>No data boxes yet. Add one below.</p>"
    : `<table><thead><tr><th>Label</th><th>dbID</th><th>Owner</th><th>Type</th><th>Sign-in</th><th>Environment</th><th>Added</th><th>Actions</th></tr></thead><tbody>
${boxes.map((box) => boxRow(csrf, secondFactor, box)).join("\n")}
</tbody></table>`
}
<h2>Add a data box</h2>
<form method="post" action="${ADD_PATH}" enctype="multipart/form-data">
${csrfField(csrf)}
<label>Label <input type="text" name="label" maxlength="64" required></label>
${credentialFields}
<button type="submit">Sign in and add</button>
<span class="muted">The server signs in to ISDS once to learn the box's dbID and owner.</span>
</form>`;
