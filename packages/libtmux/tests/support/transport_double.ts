import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";

/**
 * A transport for tests that only exercise single commands.
 *
 * `executeGroup` refuses rather than running the requests one at a time: a
 * sequential fallback would be the very non-atomicity the group primitive
 * exists to remove, and a double that quietly provided it would let a test
 * pass against behaviour the real transports do not have.
 */
export function singleCommandTransport(
  execute: (request: CommandRequest) => Promise<RawCommandResult>,
): CommandTransport {
  return {
    execute,
    executeGroup(): Promise<readonly RawCommandResult[]> {
      return Promise.reject(new Error("this test double runs one command at a time"));
    },
  };
}
