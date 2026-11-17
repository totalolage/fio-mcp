import type { Redactor } from "@mcps/core/redaction.js";
import type { SqlClient } from "effect/sql";
import type { AuditLog } from "../domain/audit-log.js";
import type { BoxClients } from "../domain/box-clients.js";
import type { BoxLocks } from "../domain/box-locks.js";
import type { BoxRegistry } from "../domain/boxes.js";
import type { DataKey, DomainConfig } from "../domain/config.js";
import type { IsdsTransports } from "../domain/isds-transports.js";
import type { ReadService } from "../domain/read-service.js";
import type { RecipientTiers } from "../domain/recipient-tiers.js";
import type { ZfoStore } from "../domain/zfo-store.js";

/**
 * The services the app builds once and provides to every tool group, admin
 * tab, extension service and background layer (src/app/extensions.ts).
 */
export type AppServices =
  | SqlClient.SqlClient
  | Redactor
  | DomainConfig
  | DataKey
  | IsdsTransports
  | BoxLocks
  | BoxRegistry
  | BoxClients
  | RecipientTiers
  | AuditLog
  | ZfoStore
  | ReadService;
