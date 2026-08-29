import type { WhereDocumentV1 } from "../../selection.js";
import {
  canonicalizeWhereDocument,
  canonicalizeWhereDocumentWire,
  canonicalJson,
} from "./compile.js";

export function encodeWhereDocument(document: WhereDocumentV1): string {
  return canonicalJson(canonicalizeWhereDocumentWire(document));
}

export function decodeWhereDocument(input: unknown): WhereDocumentV1 {
  return canonicalizeWhereDocument(input);
}
