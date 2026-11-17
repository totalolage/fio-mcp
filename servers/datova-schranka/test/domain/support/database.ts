import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import type { Migrations } from "@mcps/core/migrations.js";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { DOMAIN_MIGRATIONS } from "../../../src/domain/migrations.js";

/**
 * A fresh in-memory database with the domain migrations applied (the app
 * phase adds core's OAuth and server_settings migrations in front of them).
 */
export const memoryDatabase = (migrations: Migrations = DOMAIN_MIGRATIONS) =>
  Layer.effectDiscard(
    SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations), table: "datova_schranka_migrations" }).pipe(
      Effect.orDie,
    ),
  ).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }).pipe(Layer.orDie))) as Layer.Layer<
    SqlClient.SqlClient | SqliteClient.SqliteClient
  >;
