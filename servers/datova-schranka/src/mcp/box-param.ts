import { Schema } from "effect";

const DESCRIPTION = "Label of the data box to use (one of the boxes your grant covers).";

/**
 * The `box` input of every box-bound tool: an enum of the box labels the
 * tools were registered for. HTTP tools/list narrows the enum to the labels
 * the caller's grant covers (core grant-tools.ts); with no boxes the enum is
 * empty, so the tools are hidden and every call fails input validation.
 * The handler still resolves and authorizes the label on each call
 * (src/mcp/call.ts), since a box can be removed before the tools are
 * registered again.
 */
export const boxParameter = (labels: ReadonlyArray<string>) =>
  Schema.Literals(labels).annotate({ description: DESCRIPTION });
