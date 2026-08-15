import { v, ValidationFailure, type Validator } from "../validate.js";

import type {
  PaneId,
  PaneIdInput,
  SessionId,
  SessionIdInput,
  WindowId,
  WindowIdInput,
} from "../../common.js";
import { QueryValidationError } from "../../exc.js";

const sessionIdSchema = v.string().regex(/^\$\d+$/u, "a session id like $0");
const windowIdSchema = v.string().regex(/^@\d+$/u, "a window id like @0");
const paneIdSchema = v.string().regex(/^%\d+$/u, "a pane id like %0");

function parseId<Id extends string>(schema: Validator<string>, value: string, label: string): Id {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new QueryValidationError({
      cause: new ValidationFailure(result.issues),
      code: "invalid-id",
      message: `Invalid ${label} ID`,
    });
  }
  return result.value as Id;
}

export function parseSessionId(value: SessionIdInput): SessionId {
  return parseId<SessionId>(sessionIdSchema, value, "session");
}

export function parseWindowId(value: WindowIdInput): WindowId {
  return parseId<WindowId>(windowIdSchema, value, "window");
}

export function parsePaneId(value: PaneIdInput): PaneId {
  return parseId<PaneId>(paneIdSchema, value, "pane");
}
