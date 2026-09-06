import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CAPABILITIES_URI } from "./uris.js";

const JSON_MIME = "application/json";

export function registerResources(mcp: McpServer, report: unknown): () => Promise<void> {
  const text = JSON.stringify(report, null, 2) ?? "null";
  mcp.registerResource(
    "capabilities",
    CAPABILITIES_URI,
    {
      description: "The frozen structured-tool surface and its capability declarations.",
      mimeType: JSON_MIME,
      title: "Capabilities",
    },
    async () => ({
      contents: [{ mimeType: JSON_MIME, text, uri: CAPABILITIES_URI }],
    }),
  );
  return async (): Promise<void> => {};
}
