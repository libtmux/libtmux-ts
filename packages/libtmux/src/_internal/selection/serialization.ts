import { v, ValidationFailure } from "../validate.js";

import { QueryValidationError } from "../../exc.js";
import type { WhereDocumentV1 } from "../../selection.js";
import {
  canonicalizeWhereDocument,
  canonicalizeWhereDocumentWire,
  canonicalJson,
} from "./compile.js";

const documentFor = (model: "client" | "pane" | "session" | "window") =>
  v.strictObject({
    model: v.literal(model),
    version: v.literal(1),
    where: v.record(v.unknown()),
  });

const whereDocumentSchema = v.discriminatedUnion(
  "model",
  [documentFor("client"), documentFor("session"), documentFor("window"), documentFor("pane")],
  ["client", "session", "window", "pane"],
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
  const validated = validatedDocument(document);
  return canonicalJson(canonicalizeWhereDocumentWire(validated));
}

export function decodeWhereDocument(input: unknown): WhereDocumentV1 {
  return validatedDocument(input);
}
