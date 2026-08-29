import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";

/** A transport whose result is supplied by one focused test callback. */
export function singleCommandTransport(
  execute: (request: CommandRequest) => Promise<RawCommandResult>,
): CommandTransport {
  return { execute };
}
