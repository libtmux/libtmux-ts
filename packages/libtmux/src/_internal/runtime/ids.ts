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

const sessionIdPattern = /^\$\d+$/u;
const windowIdPattern = /^@\d+$/u;
const paneIdPattern = /^%\d+$/u;

const sessionIdSchema = v.string().regex(sessionIdPattern, "a session id like $0");
const windowIdSchema = v.string().regex(windowIdPattern, "a window id like @0");
const paneIdSchema = v.string().regex(paneIdPattern, "a pane id like %0");

export function isSessionId(value: unknown): value is SessionId {
  return typeof value === "string" && sessionIdPattern.test(value);
}

export function isWindowId(value: unknown): value is WindowId {
  return typeof value === "string" && windowIdPattern.test(value);
}

export function isPaneId(value: unknown): value is PaneId {
  return typeof value === "string" && paneIdPattern.test(value);
}

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
