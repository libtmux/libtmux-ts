import { describe, expect, test } from "bun:test";

import { observerBoundTransport } from "../../src/_internal/control/observer_transport.js";
import type { ControlObserverBinding } from "../../src/_internal/control/connection.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import type { CommandRequest, RawCommandResult } from "../../src/_internal/transport/types.js";
import { TmuxServerRestartedError, TmuxTransportError } from "../../src/errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const daemon = Object.freeze({ pid: "4242", startTime: "1700" });
const observerBinding: ControlObserverBinding = Object.freeze({ clientPid: 123, daemon });
const observer = { observerBinding: () => observerBinding };
const connection = new TmuxConnection({ executable: "tmux", socketPath: "/tmp/test.sock" });
type TransportOptions = Parameters<typeof observerBoundTransport>[0];
type Staging = NonNullable<TransportOptions["staging"]>;
const location = Object.freeze({ directory: "/staged", inputPath: "/staged/stdin" });

function staging(overrides: Partial<Staging> = {}): Staging {
  return {
    create: () => Promise.resolve(location),
    remove: () => Promise.resolve(),
    write: () => Promise.resolve(),
    ...overrides,
  };
}

function rawResult(
  request: CommandRequest,
  output: { readonly stderr?: string; readonly stdout?: string } = {},
): RawCommandResult {
  return {
    cmd: [request.executable, ...request.globalArgs, ...request.commands.flat()],
    exitCode: 0,
    signal: null,
    stderr: encoder.encode(output.stderr ?? ""),
    stdout: encoder.encode(output.stdout ?? ""),
  };
}

function invocation(options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}) {
  return {
    commands: [["new-session", "-d", "-s", "late"]],
    executable: "tmux",
    globalArgs: [],
    ...options,
  } as const;
}

function stdinInvocation(
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
) {
  return {
    ...invocation(options),
    commands: [["load-buffer", "-"]],
    stdin: encoder.encode("sensitive"),
  } as const;
}

function harness(
  options: {
    readonly execute?: (request: CommandRequest) => Promise<RawCommandResult>;
    readonly staging?: Staging;
  } = {},
) {
  let userCommands = 0;
  const requests: CommandRequest[] = [];
  const commands = {
    async execute(request: CommandRequest): Promise<RawCommandResult> {
      requests.push(request);
      userCommands += 1;
      return options.execute === undefined ? rawResult(request) : options.execute(request);
    },
  };
  const transport = observerBoundTransport({
    commands,
    connection,
    observer,
    ...(options.staging === undefined ? {} : { staging: options.staging }),
  });
  return { requests, transport, userCommands: () => userCommands };
}

async function rejected(execution: Promise<RawCommandResult>): Promise<unknown> {
  try {
    await execution;
  } catch (error) {
    return error;
  }
  throw new Error("expected transport failure");
}

function blockingPhase() {
  const entered = Promise.withResolvers<CommandRequest["signal"]>();
  let aborted = false;
  return {
    aborted: () => aborted,
    entered: entered.promise,
    async wait(signal: CommandRequest["signal"]): Promise<void> {
      entered.resolve(signal);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearTimeout(timer);
            reject(new Error("staging cancelled"));
          },
          { once: true },
        );
      });
    },
  };
}

describe("connected observer transport", () => {
  for (const mode of ["timeout", "abort"] as const) {
    test(`${mode} covers stdin staging`, async () => {
      const kind = mode === "abort" ? "cancelled" : "timeout";
      const controller = new AbortController();
      const blocked = blockingPhase();
      let removed = 0;
      const target = harness({
        staging: staging({
          remove: () => {
            removed += 1;
            return Promise.resolve();
          },
          write: (_path, _data, signal) => blocked.wait(signal),
        }),
      });
      const execution = target.transport.execute(
        stdinInvocation(mode === "timeout" ? { timeoutMs: 10 } : { signal: controller.signal }),
      );
      await blocked.entered;
      if (mode === "abort") controller.abort();

      expect(await rejected(execution)).toMatchObject({ delivery: "not_started", kind });
      expect(blocked.aborted()).toBe(true);
      expect(target.userCommands()).toBe(0);
      expect(removed).toBe(1);
    });
  }

  test("cleans up a directory created as its request expires", async () => {
    let removed = 0;
    let writes = 0;
    const input = staging({
      create: async (signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return location;
      },
      remove: () => {
        removed += 1;
        return Promise.resolve();
      },
      write: () => {
        writes += 1;
        return Promise.resolve();
      },
    });
    const target = harness({ staging: input });

    expect(
      await rejected(target.transport.execute(stdinInvocation({ timeoutMs: 10 }))),
    ).toMatchObject({ delivery: "not_started", kind: "timeout" });
    expect({ removed, userCommands: target.userCommands(), writes }).toEqual({
      removed: 1,
      userCommands: 0,
      writes: 0,
    });
  });

  test("reports cleanup failure with the command's exact delivery and evidence", async () => {
    for (const delivery of ["replied", "not_started", "written", "indeterminate"] as const) {
      const cleanup = new Error(`cleanup:${delivery}`);
      const primary =
        delivery === "replied"
          ? undefined
          : new TmuxTransportError(`command:${delivery}`, {
              delivery,
              kind: "timeout",
              signal: "SIGTERM",
              stderr: encoder.encode(`stderr:${delivery}`),
              stdout: encoder.encode(`stdout:${delivery}`),
            });
      const target = harness({
        execute: (request) =>
          primary === undefined
            ? Promise.resolve(
                rawResult(request, { stderr: `stderr:${delivery}`, stdout: `stdout:${delivery}` }),
              )
            : Promise.reject(primary),
        staging: staging({
          remove: () => Promise.reject(cleanup),
        }),
      });

      // eslint-disable-next-line no-await-in-loop -- each case owns one authenticated transport.
      const failure = await rejected(target.transport.execute(stdinInvocation()));
      expect(failure).toMatchObject({ delivery, kind: "spawn" });
      expect(failure).toBeInstanceOf(TmuxTransportError);
      const transportFailure = failure as TmuxTransportError;
      expect(decoder.decode(transportFailure.stderr)).toBe(`stderr:${delivery}`);
      expect(decoder.decode(transportFailure.stdout)).toBe(`stdout:${delivery}`);
      if (primary === undefined) expect(transportFailure.cause).toBe(cleanup);
      else expect((transportFailure.cause as AggregateError).errors).toEqual([primary, cleanup]);
    }
  });

  test("reports both pre-command staging and cleanup failures", async () => {
    const stagingFailure = new Error("write failed");
    const cleanup = new Error("cleanup failed");
    const target = harness({
      staging: staging({
        remove: () => Promise.reject(cleanup),
        write: () => Promise.reject(stagingFailure),
      }),
    });

    const failure = (await rejected(
      target.transport.execute(stdinInvocation()),
    )) as TmuxTransportError;
    expect(failure).toMatchObject({ delivery: "not_started", kind: "spawn" });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const [wrappedStaging, reportedCleanup] = (failure.cause as AggregateError).errors;
    expect(wrappedStaging).toMatchObject({ delivery: "not_started", kind: "spawn" });
    expect((wrappedStaging as Error).cause).toBe(stagingFailure);
    expect(reportedCleanup).toBe(cleanup);
    expect(target.userCommands()).toBe(0);
  });

  test("fences spawned commands to the daemon the observer was admitted on", async () => {
    const target = harness();

    await target.transport.execute(invocation());

    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]?.daemonGuard).toEqual(daemon);
    expect(target.requests.every((request) => request.commands[0][0] !== "list-clients")).toBe(
      true,
    );
  });

  test("refuses a command whose ids belong to another daemon", async () => {
    const target = harness();

    expect(
      await rejected(
        target.transport.execute({
          ...invocation(),
          daemonGuard: { pid: "1", startTime: "2" },
        }),
      ),
    ).toBeInstanceOf(TmuxServerRestartedError);
    expect(target.userCommands()).toBe(0);
  });

  test("refuses to send anything for an observer that was never admitted", async () => {
    const unadmitted = { observerBinding: () => Object.freeze({ clientPid: 123 }) };
    let sent = 0;
    const transport = observerBoundTransport({
      commands: {
        execute: (request) => {
          sent += 1;
          return Promise.resolve(rawResult(request));
        },
      },
      connection,
      observer: unadmitted,
    });

    expect(await rejected(transport.execute(invocation()))).toBeInstanceOf(
      TmuxServerRestartedError,
    );
    expect(sent).toBe(0);
  });
});
