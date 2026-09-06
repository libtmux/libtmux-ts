import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "bun:test";

import { boundRequestIds, MAX_SERIALIZED_REQUEST_ID_BYTES } from "../src/protocol_transport.js";

test("request IDs that cannot fit a bounded reply fail before dispatch", async () => {
  const [peer, server] = InMemoryTransport.createLinkedPair();
  const transport = boundRequestIds(server);
  const received: JSONRPCMessage[] = [];
  let dispatched = 0;

  peer.onmessage = (message): void => {
    received.push(message);
  };
  transport.onmessage = (): void => {
    dispatched += 1;
  };
  await Promise.all([peer.start(), transport.start()]);

  await peer.send({
    id: "i".repeat(MAX_SERIALIZED_REQUEST_ID_BYTES - 2),
    jsonrpc: "2.0",
    method: "tools/list",
  });
  expect(dispatched).toBe(1);
  expect(received).toEqual([]);

  await peer.send({
    id: "i".repeat(1_000_000),
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: {}, name: "create_session" },
  });
  expect(dispatched).toBe(1);
  expect(received as unknown).toEqual([
    {
      error: { code: -32600, message: "Request ID exceeds the response framing limit" },
      jsonrpc: "2.0",
    },
  ]);
  expect(() => JSONRPCMessageSchema.parse(received[0])).not.toThrow();
  expect(Buffer.byteLength(`${JSON.stringify(received[0])}\n`, "utf8")).toBeLessThanOrEqual(
    1_000_000,
  );
});
