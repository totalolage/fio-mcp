import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { makeFioToolkit } from "../src/mcp/fio-tools.js";

const inputSchemas = (accountNames: ReadonlyArray<string>) =>
  Object.values(makeFioToolkit(accountNames).tools).map((tool) => ({
    name: tool.name,
    schema: Schema.toJsonSchemaDocument(tool.parametersSchema).schema,
  }));

describe("tool parameter schemas", () => {
  it.effect("every tool has an object-rooted input schema with one or several accounts", () =>
    Effect.sync(() => {
      for (const names of [["main"], ["personal", "business"]]) {
        for (const { name, schema } of inputSchemas(names)) {
          assert.strictEqual(schema.type, "object", `${name} with ${names.length} account(s)`);
        }
      }
    }),
  );
});
