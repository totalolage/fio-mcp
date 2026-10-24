import { NodeFileSystem } from "@effect/platform-node";
import { Layer } from "effect";
import { CACHE_MIGRATIONS, Database, type Migrations } from "../../src/cache/db.js";

/** The production database layer on `filename`, with the real file system. */
export const testDatabase = (filename: string, migrations: Migrations = CACHE_MIGRATIONS) =>
  Database.layer(filename, migrations).pipe(Layer.provide(NodeFileSystem.layer));

/** A fresh in-memory database with `migrations` applied. */
export const memoryDatabase = (migrations: Migrations = CACHE_MIGRATIONS) => testDatabase(":memory:", migrations);
