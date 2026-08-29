import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  type ListResourcesResult,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerSnapshot } from "libtmux";

import { paneEntities, windowEntities, type ToolContext } from "./context.js";
import { MAX_RESULT_BYTES } from "./policy.js";
import { tailBytes } from "./results.js";
import {
  paneContentUri,
  paneUri,
  sessionUri,
  windowUri,
  CLIENTS_URI,
  PANES_URI,
  SESSIONS_URI,
  WINDOWS_URI,
} from "./uris.js";

export const JSON_MIME = "application/json";
/** Pane contents are terminal text: neither JSON to parse nor HTML to render. */
export const TEXT_MIME = "text/plain";

const RESOURCE_CURSOR_PREFIX = "libtmux.resources.v1.";
const RESOURCE_LIST_PREFIX = '{"resources":[';
const RESOURCE_LIST_PREFIX_BYTES = Buffer.byteLength(RESOURCE_LIST_PREFIX, "utf8");

interface ResourceCursor {
  readonly after: string;
  readonly fingerprint: string;
}

function descriptorText(value: string): string {
  const bounded = tailBytes(value, 4 * 1_024);
  return `${bounded.droppedBytes === 0 ? "" : "…"}${bounded.text}`;
}

function invalidResourceCursor(): never {
  throw new McpError(
    ErrorCode.InvalidParams,
    "Invalid resources/list cursor; restart the listing without a cursor.",
  );
}

function encodeResourceCursor(cursor: ResourceCursor): string {
  return `${RESOURCE_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function decodeResourceCursor(cursor: string | undefined): ResourceCursor | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor.startsWith(RESOURCE_CURSOR_PREFIX) || cursor.length > 4096) {
    return invalidResourceCursor();
  }
  const encoded = cursor.slice(RESOURCE_CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return invalidResourceCursor();

  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
    return invalidResourceCursor();
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return invalidResourceCursor();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 2 ||
    !("after" in value) ||
    typeof value.after !== "string" ||
    !("fingerprint" in value) ||
    typeof value.fingerprint !== "string"
  ) {
    return invalidResourceCursor();
  }
  return { after: value.after, fingerprint: value.fingerprint };
}

function resourceDescriptors(snapshot: ServerSnapshot): Resource[] {
  return [
    {
      description: "Every session on this server.",
      mimeType: JSON_MIME,
      name: "sessions",
      title: "Sessions",
      uri: SESSIONS_URI,
    },
    {
      description: "Every window on this server.",
      mimeType: JSON_MIME,
      name: "windows",
      title: "Windows",
      uri: WINDOWS_URI,
    },
    {
      description: "Every pane on this server.",
      mimeType: JSON_MIME,
      name: "panes",
      title: "Panes",
      uri: PANES_URI,
    },
    {
      description: "Who is attached, and which pane each is looking at.",
      mimeType: JSON_MIME,
      name: "clients",
      title: "Clients",
      uri: CLIENTS_URI,
    },
    ...snapshot.sessions.toArray().map((session) => ({
      description: "One session with its windows.",
      mimeType: JSON_MIME,
      name: descriptorText(session.name ?? session.id),
      title: "Session",
      uri: sessionUri(session.id),
    })),
    ...windowEntities(snapshot.windows.toArray()).map((window) => ({
      description: "One window with its panes.",
      mimeType: JSON_MIME,
      name: descriptorText(window.name ?? window.id),
      title: "Window",
      uri: windowUri(window.id),
    })),
    ...paneEntities(snapshot.panes.toArray()).map((pane) => ({
      description: `One pane running ${descriptorText(pane.currentCommand ?? "an unknown command")}.`,
      mimeType: JSON_MIME,
      name: pane.id,
      title: "Pane",
      uri: paneUri(pane.id),
    })),
    ...paneEntities(snapshot.panes.toArray()).map((pane) => ({
      description: `What ${pane.id} is showing.`,
      mimeType: TEXT_MIME,
      name: `${pane.id} contents`,
      title: "Pane contents",
      uri: paneContentUri(pane.id),
    })),
  ].sort((left, right) => (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0));
}

function resourcePage(
  resources: readonly Resource[],
  cursor: ResourceCursor | undefined,
): ListResourcesResult {
  const fingerprint = createHash("sha256").update(JSON.stringify(resources)).digest("base64url");
  let start = 0;
  if (cursor !== undefined) {
    if (cursor.fingerprint !== fingerprint) return invalidResourceCursor();
    const index = resources.findIndex((resource) => resource.uri === cursor.after);
    if (index < 0 || index === resources.length - 1) return invalidResourceCursor();
    start = index + 1;
  }

  const page: Resource[] = [];
  let bodyBytes = 0;
  let nextCursor: string | undefined;
  for (let index = start; index < resources.length; index += 1) {
    const resource = resources[index];
    if (resource === undefined) break;
    const resourceBytes = Buffer.byteLength(JSON.stringify(resource), "utf8");
    const candidateBodyBytes = bodyBytes + resourceBytes + (page.length === 0 ? 0 : 1);
    const candidateCursor =
      index + 1 < resources.length
        ? encodeResourceCursor({ after: resource.uri, fingerprint })
        : undefined;
    const suffix =
      candidateCursor === undefined ? "]}" : `],"nextCursor":${JSON.stringify(candidateCursor)}}`;
    if (
      RESOURCE_LIST_PREFIX_BYTES + candidateBodyBytes + Buffer.byteLength(suffix, "utf8") >
      MAX_RESULT_BYTES
    ) {
      break;
    }
    page.push(resource);
    bodyBytes = candidateBodyBytes;
    nextCursor = candidateCursor;
  }

  if (page.length === 0 && start < resources.length) {
    throw new McpError(
      ErrorCode.InternalError,
      `Resource descriptor ${resources[start]?.uri ?? "at the requested cursor"} exceeds the result ceiling.`,
    );
  }
  const result: ListResourcesResult =
    nextCursor === undefined ? { resources: page } : { nextCursor, resources: page };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
    throw new McpError(ErrorCode.InternalError, "Resource pagination exceeded the result ceiling.");
  }
  return result;
}

export function registerResourceCatalog(
  mcp: McpServer,
  context: ToolContext,
  watching: () => void,
): void {
  mcp.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const after = decodeResourceCursor(request.params?.cursor);
    watching();
    const resources = resourceDescriptors(await context.snapshot());
    return resourcePage(resources, after);
  });
}
