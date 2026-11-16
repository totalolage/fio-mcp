import { NodeFileSystem } from "@effect/platform-node";
import { Layer } from "effect";
import { CACHE_MIGRATIONS, Database, type Migrations } from "../../src/cache/db.js";
import type { CacheSealing } from "../../src/cache/encryption.js";

/** The production database layer on `filename`, with the real file system; with `sealing`, reconciled to it at startup. */
export const testDatabase = (filename: string, migrations: Migrations = CACHE_MIGRATIONS, sealing?: CacheSealing) =>
  Database.layer(filename, migrations, sealing).pipe(Layer.provide(NodeFileSystem.layer));

/** A fresh in-memory database with `migrations` applied. */
export const memoryDatabase = (migrations: Migrations = CACHE_MIGRATIONS) => testDatabase(":memory:", migrations);
