import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const MAX_SERIALIZED_REQUEST_ID_BYTES = 512 * 1024;

/** Reject a request ID that cannot leave room for a bounded response. */
export function boundRequestIds(inner: Transport): Transport {
  const outer: Transport = {
    close: () => inner.close(),
    send: (message: JSONRPCMessage, options?: TransportSendOptions) => inner.send(message, options),
    start: () => inner.start(),
  };

  inner.onclose = (): void => outer.onclose?.();
  inner.onerror = (error): void => outer.onerror?.(error);
  inner.onmessage = (message, extra): void => {
    if (hasOversizedRequestId(message)) {
      const response: JSONRPCMessage = {
        error: {
          code: ErrorCode.InvalidRequest,
          message: "Request ID exceeds the response framing limit",
        },
        jsonrpc: "2.0",
      };
      void inner.send(response).catch((error: unknown) => {
        outer.onerror?.(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    outer.onmessage?.(message, extra);
  };
  if (inner.setProtocolVersion !== undefined) {
    outer.setProtocolVersion = (version): void => inner.setProtocolVersion?.(version);
  }

  return outer;
}

function hasOversizedRequestId(message: JSONRPCMessage): boolean {
  if (!("method" in message) || !("id" in message)) return false;
  return Buffer.byteLength(JSON.stringify(message.id), "utf8") > MAX_SERIALIZED_REQUEST_ID_BYTES;
}
