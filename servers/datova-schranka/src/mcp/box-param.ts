import { Schema } from "effect";

const DESCRIPTION = "Label of the data box to use (one of the boxes your grant covers).";

/**
 * The `box` input of every box-bound tool: an enum of the box labels the
 * tools were registered for. HTTP tools/list narrows the enum to the labels
 * the caller's grant covers (core grant-tools.ts), which needs a plain
 * `{type: "string", enum: [...]}` property: one label is a single Literal
 * (Literals of one encodes as an anyOf, which the filter would hide). With
 * no boxes the property has no enum, so the tools are hidden and every call
 * fails input validation. The handler still resolves and authorizes the
 * label on each call (src/mcp/call.ts), since a box can be removed before
 * the tools are registered again.
 */
export const boxParameter = (labels: ReadonlyArray<string>) => {
  const [only, ...rest] = labels;
  const schema: Schema.Codec<string> =
    only !== undefined && rest.length === 0 ? Schema.Literal(only) : Schema.Literals(labels);
  return schema.annotate({ description: DESCRIPTION });
};
