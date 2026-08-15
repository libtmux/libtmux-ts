import { v, ValidationFailure } from "../validate.js";

import { QueryValidationError } from "../../exc.js";
import type { WhereDocumentV1 } from "../../selection.js";
import { canonicalizeWhereDocument, canonicalJson } from "./compile.js";

const documentFor = (model: "pane" | "session" | "window") =>
  v.strictObject({
    model: v.literal(model),
    version: v.literal(1),
    where: v.record(v.unknown()),
  });

const whereDocumentSchema = v.discriminatedUnion(
  "model",
  [documentFor("session"), documentFor("window"), documentFor("pane")],
  ["session", "window", "pane"],
);

function invalidDocument(cause?: unknown): never {
  throw new QueryValidationError({
    ...(cause === undefined ? {} : { cause }),
    code: "invalid-query",
    message: "Invalid WHERE document",
  });
}

function validatedDocument(input: unknown): WhereDocumentV1 {
  const document = canonicalizeWhereDocument(input);
  const result = whereDocumentSchema.safeParse(document);
  if (!result.success) return invalidDocument(new ValidationFailure(result.issues));
  return document;
}

export function encodeWhereDocument(document: WhereDocumentV1): string {
  return canonicalJson(validatedDocument(document) as Readonly<Record<string, unknown>>);
}

export function decodeWhereDocument(input: unknown): WhereDocumentV1 {
  return validatedDocument(input);
}
