import { describe, expect, test } from "bun:test";

import {
  TmuxServerRestartedError,
  TmuxTransportError,
  VersionTooLowError,
} from "../../src/errors.js";
import { flattenInvocation } from "../../src/_internal/transport/invocation.js";
import {
  VersionCheckTransport,
  daemonProbe,
  interpretProbe,
  requireCoreVersion,
} from "../../src/_internal/support/versions.js";
import { releaseAtLeast } from "../../src/_internal/runtime/tmux_version.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";
import { answerVersionProbe, probeMarker } from "../support/version_probe.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function answer(
  request: CommandRequest,
  exitCode: number,
  stderr = "",
  stdout = "",
): RawCommandResult {
  return {
    cmd: Object.freeze([request.executable, ...flattenInvocation(request)]),
    exitCode,
    signal: null,
    stderr: encoder.encode(stderr),
    stdout: encoder.encode(stdout),
  };
}

/** A fake client that records what it was asked and answers like the tmux it stands for. */
class FakeTmux implements CommandTransport {
  readonly requests: CommandRequest[] = [];
  /** `undefined` is an absent endpoint. */
  daemon: string | undefined;
  client = "3.7d";
  clientName = "tmux";
  /** How long a fenced command takes to come back. */
  fenceDelayMs = 0;

  constructor(daemon: string | undefined) {
    this.daemon = daemon;
  }

  get probes(): CommandRequest[] {
    return this.requests.filter((request) => probeMarker(request) !== undefined);
  }

  /** Everything that reached the engine other than a probe or a client-only report. */
  get dispatched(): CommandRequest[] {
    return this.requests.filter(
      (request) => probeMarker(request) === undefined && !request.globalArgs.includes("-V"),
    );
  }

  execute(request: CommandRequest): Promise<RawCommandResult> {
    this.requests.push(request);
    if (request.globalArgs.includes("-V")) {
      return Promise.resolve(answer(request, 0, "", `${this.clientName} ${this.client}\n`));
    }
    if (probeMarker(request) !== undefined) {
      return Promise.resolve(
        this.daemon === undefined
          ? answer(request, 1, "no server running on /tmp/fake\n")
          : answerVersionProbe(request, this.daemon),
      );
    }
    const [fence, ...rest] = request.commands;
    if (fence?.[0] === "if-shell" && this.fenceDelayMs > 0) {
      const delay = this.fenceDelayMs;
      this.fenceDelayMs = 0;
      return new Promise((resolve) => setTimeout(resolve, delay)).then(() => this.execute(request));
    }
    if (fence?.[0] === "if-shell") {
      const condition = fence[2] ?? "";
      const refusal = fence[4] ?? "";
      const running = this.daemon ?? (request.globalArgs.includes("-N") ? undefined : this.client);
      if (running === undefined) return Promise.resolve(answer(request, 1, "no server running\n"));
      if (condition !== `#{==:#{version},${running}}`) {
        return Promise.resolve(answer(request, 1, `unknown command: ${refusal}\n`));
      }
      return Promise.resolve(answer(request, 0, "", `ran ${rest.map((c) => c[0]).join(",")}\n`));
    }
    return Promise.resolve(answer(request, 0));
  }
}

function request(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    commands: [["list-sessions"]],
    executable: "/usr/bin/tmux",
    globalArgs: ["-S/tmp/fake"],
    ...overrides,
  };
}

/** Every form tmux has printed, and the forms it never has; the floor is 3.3a. */
const SUPPORTED = [
  "3.3a",
  "3.4",
  "3.7d",
  "3.8",
  "3.10",
  "4.0",
  "3.4-rc",
  "3.8-rc",
  "3.8-rc2",
  "next-3.4",
  "next-3.9",
];
const BELOW = ["3.3", "3.2a", "3.3-rc", "3.2-rc5", "next-3.3"];
const UNPARSEABLE = [
  "master",
  "openbsd-7.6",
  "",
  "3",
  "garbage",
  "3.3a garbage",
  "3.3a-master",
  "3.3a-dev",
  "next-3.3a",
  "next-3.9-master",
  "3.4a-rc",
  "3.3a\n3.4",
];

describe("core version floor", () => {
  test.each(SUPPORTED)("accepts %s", (raw) => {
    expect(requireCoreVersion(raw).raw).toBe(raw);
  });

  test.each([...BELOW, ...UNPARSEABLE])("refuses %p", (raw) => {
    expect(() => requireCoreVersion(raw)).toThrow(VersionTooLowError);
  });

  test("reports the version it refused, and that nothing started", () => {
    try {
      requireCoreVersion("3.3");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(VersionTooLowError);
      expect(error).toMatchObject({ delivery: "not_started", serverVersion: "3.3", since: "3.3a" });
    }
  });

  test("names the remedy for a version below the floor", () => {
    expect(() => requireCoreVersion("3.2a")).toThrow(
      /libtmux needs tmux 3\.3a; this server is 3\.2a\. Upgrade tmux and restart the server, or pin the previous libtmux release/u,
    );
  });

  test.each(["master", "openbsd-7.6", "3.3a-dev"])(
    "calls %s unrecognized rather than blaming the server",
    (raw) => {
      let caught: unknown;
      try {
        requireCoreVersion(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(VersionTooLowError);
      const message = (caught as Error).message;
      expect(message).toContain(`reports "${raw}", an unrecognized version, which is refused`);
      expect(message).not.toContain(`this server is ${raw}`);
      expect(caught).toMatchObject({ recognized: false });
    },
  );

  test("marks a release below the floor as recognized", () => {
    expect(() => requireCoreVersion("3.2a")).toThrow(
      expect.objectContaining({ recognized: true, serverVersion: "3.2a" }),
    );
  });

  test("ranks a development build below its candidates and its candidates below the release", () => {
    const ascending = ["next-3.7", "3.7-rc", "3.7-rc3", "3.7", "3.7a"];
    for (const [index, lower] of ascending.entries()) {
      for (const higher of ascending.slice(index + 1)) {
        expect(releaseAtLeast(higher, lower), `${higher} >= ${lower}`).toBe(true);
        expect(releaseAtLeast(lower, higher), `${lower} >= ${higher}`).toBe(false);
      }
    }
    expect(releaseAtLeast("next-3.4", "3.4-rc")).toBe(false);
    expect(releaseAtLeast("3.4-rc", "3.4")).toBe(false);
    expect(releaseAtLeast("3.10", "3.9")).toBe(true);
  });

  test("lets 3.8-rc2 and next-3.8 reach 3.7 and keeps next-3.7 and 3.7-rc2 below it", () => {
    expect(releaseAtLeast("3.8-rc2", "3.7")).toBe(true);
    expect(releaseAtLeast("next-3.8", "3.7")).toBe(true);
    expect(releaseAtLeast("next-3.7", "3.7")).toBe(false);
    expect(releaseAtLeast("3.7-rc2", "3.7")).toBe(false);
  });
});

describe("version probe", () => {
  test("reads the daemon from tmux's refusal of the expanded marker", () => {
    const { marker, request: probe } = daemonProbe({
      executable: "tmux",
      globalArgs: ["-S/tmp/x"],
    });
    expect(probe.globalArgs).toEqual(["-S/tmp/x", "-N"]);
    expect(probe.commands).toEqual([
      ["run-shell", "-C", `${marker}#{version}/#{pid}/#{start_time}`],
    ]);

    const outcome = interpretProbe(
      answerVersionProbe(probe, "next-3.9", { pid: "7", startTime: "9" }),
      marker,
    );
    expect(outcome).toEqual({
      kind: "daemon",
      reading: { daemon: { pid: "7", startTime: "9" }, rawVersion: "next-3.9" },
    });
  });

  test("tells an absent endpoint from any other failure", () => {
    const { marker, request: probe } = daemonProbe({ executable: "tmux", globalArgs: [] });
    expect(interpretProbe(answer(probe, 1, "no server running on /tmp/x\n"), marker).kind).toBe(
      "absent",
    );
    expect(
      interpretProbe(
        answer(probe, 1, "error connecting to /tmp/x (No such file or directory)\n"),
        marker,
      ).kind,
    ).toBe("absent");
    expect(
      interpretProbe(answer(probe, 1, "error connecting to /tmp/x (Connection refused)\n"), marker)
        .kind,
    ).toBe("absent");
    expect(() =>
      interpretProbe(answer(probe, 1, "error connecting to /tmp/x (Permission denied)\n"), marker),
    ).toThrow(/cannot reach tmux: error connecting to/u);
    expect(() => interpretProbe(answer(probe, 0, "", "3.7\n"), marker)).toThrow(
      /cannot reach tmux/u,
    );
  });

  test.each([
    ["a client before 3.2 rejects -N", "tmux: unknown option -- N\nusage: tmux [-2CluvV]"],
    [
      "a daemon before 3.2 has no run-shell -C",
      "usage: run-shell [-b] [-t target-pane] shell-command",
    ],
    ["a client refuses a daemon of tmux 3.0", "server version is too old for client"],
  ])("reads %s as a version below the floor", (_name, stderr) => {
    const { marker, request: probe } = daemonProbe({ executable: "tmux", globalArgs: [] });
    let caught: unknown;
    try {
      interpretProbe(answer(probe, 1, `${stderr}\n`), marker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VersionTooLowError);
    expect(caught).toMatchObject({ delivery: "not_started", since: "3.3a" });
  });

  test("reports an unreadable probe as not started", () => {
    const { marker, request: probe } = daemonProbe({ executable: "tmux", globalArgs: [] });
    let caught: unknown;
    try {
      interpretProbe(answer(probe, 1, "something unexpected\n"), marker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TmuxTransportError);
    expect(caught).toMatchObject({ delivery: "not_started", kind: "protocol" });
    expect((caught as Error).message).toBe("cannot reach tmux: something unexpected");
  });

  test("does not take another marker's refusal for its own", () => {
    const first = daemonProbe({ executable: "tmux", globalArgs: [] });
    const second = daemonProbe({ executable: "tmux", globalArgs: [] });
    expect(first.marker).not.toBe(second.marker);
    expect(() => interpretProbe(answerVersionProbe(second.request, "3.8"), first.marker)).toThrow(
      /cannot reach tmux/u,
    );
  });
});

describe("version check", () => {
  test("probes once, then fences each invocation with the checked release", async () => {
    const tmux = new FakeTmux("3.3a");
    const transport = new VersionCheckTransport(tmux);

    await transport.execute(request());
    await transport.execute(request({ commands: [["list-windows"]] }));

    expect(tmux.probes).toHaveLength(1);
    expect(tmux.dispatched).toHaveLength(2);
    for (const sent of tmux.dispatched) {
      const [fence, ...commands] = sent.commands;
      expect(fence).toEqual([
        "if-shell",
        "-F",
        "#{==:#{version},3.3a}",
        "",
        expect.stringMatching(/^libtmux-version-[0-9a-f]{32}$/u),
      ]);
      expect(commands).toHaveLength(1);
      expect(sent.globalArgs).toEqual(["-S/tmp/fake", "-N"]);
    }
    expect(tmux.dispatched[0]!.commands[0]![4]).not.toBe(tmux.dispatched[1]!.commands[0]![4]);
  });

  test("reports the caller's command rather than the fence", async () => {
    const transport = new VersionCheckTransport(new FakeTmux("3.8"));
    const result = await transport.execute(request());
    expect(result.cmd).toEqual(["/usr/bin/tmux", "-S/tmp/fake", "list-sessions"]);
    expect(decoder.decode(result.stdout)).toBe("ran list-sessions\n");
  });

  test.each(["3.2a", "3.3", "master", "next-3.3a", "3.3a-master"])(
    "refuses a %s daemon before the command is sent",
    async (daemon) => {
      const tmux = new FakeTmux(daemon);
      const transport = new VersionCheckTransport(tmux);

      const failure = await transport
        .execute(request({ commands: [["kill-server"]] }))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(VersionTooLowError);
      expect(failure).toMatchObject({ delivery: "not_started", serverVersion: daemon });
      expect(tmux.dispatched).toHaveLength(0);
    },
  );

  test("checks the daemon, not the client that reports a newer release", async () => {
    const tmux = new FakeTmux("3.3");
    tmux.client = "3.8";
    const transport = new VersionCheckTransport(tmux);
    await expect(
      transport.execute(request({ commands: [["new-session", "-d"]] })),
    ).rejects.toBeInstanceOf(VersionTooLowError);
    expect(tmux.dispatched).toHaveLength(0);
  });

  test("serves a newer daemon whatever an older client reports", async () => {
    const tmux = new FakeTmux("3.8");
    tmux.client = "3.3a";
    const result = await new VersionCheckTransport(tmux).execute(request());
    expect(result.exitCode).toBe(0);
  });

  test("a replaced daemon cannot inherit the version check", async () => {
    const tmux = new FakeTmux("3.3a");
    const transport = new VersionCheckTransport(tmux);
    await transport.execute(request());

    tmux.daemon = "3.2a";
    const failure = await transport.execute(request()).catch((error: unknown) => error);

    // The fence refuses the command, and a probe of the replacement says why.
    expect(failure).toBeInstanceOf(VersionTooLowError);
    expect(failure).toMatchObject({ delivery: "not_started", serverVersion: "3.2a" });
    await expect(transport.execute(request())).rejects.toBeInstanceOf(VersionTooLowError);
    expect(tmux.probes).toHaveLength(3);
  });

  test("a supported replacement reports the restart, not a refusal", async () => {
    const tmux = new FakeTmux("3.3a");
    const transport = new VersionCheckTransport(tmux);
    await transport.execute(request());

    tmux.daemon = "3.8";
    const failure = await transport.execute(request()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TmuxServerRestartedError);
    expect(failure).toMatchObject({ delivery: "not_started" });
    expect((await transport.execute(request())).exitCode).toBe(0);
  });

  test("probes a replacement only within what is left of the deadline", async () => {
    const tmux = new FakeTmux("3.3a");
    const transport = new VersionCheckTransport(tmux);
    await transport.execute(request());

    tmux.daemon = "3.2a";
    tmux.fenceDelayMs = 80;
    const failure = await transport
      .execute(request({ timeoutMs: 40 }))
      .catch((error: unknown) => error);

    // The fenced command used the whole deadline, so the replacement is not
    // probed, and the timeout is reported as one.
    expect(failure).toBeInstanceOf(TmuxTransportError);
    expect(failure).toMatchObject({ delivery: "not_started", kind: "timeout" });
    expect(tmux.probes).toHaveLength(1);
  });

  test("answers an absent endpoint with the failure the probe saw, sending nothing", async () => {
    const tmux = new FakeTmux(undefined);
    const result = await new VersionCheckTransport(tmux).execute(
      request({ commands: [["kill-server"]] }),
    );
    expect(result.exitCode).toBe(1);
    expect(decoder.decode(result.stderr)).toBe("no server running on /tmp/fake\n");
    expect(tmux.dispatched).toHaveLength(0);
  });

  test.each([
    ["new-session", ["new-session", "-d"]],
    ["new alias", ["new", "-d"]],
    ["start-server", ["start-server"]],
    ["attach prefix", ["attach", "-t", "x"]],
  ])(
    "starts a server at an absent endpoint only for a supported executable (%s)",
    async (_name, command) => {
      const tmux = new FakeTmux(undefined);
      tmux.client = "3.8";
      const transport = new VersionCheckTransport(tmux);
      await transport.execute(request({ commands: [command as [string, ...string[]]] }));

      expect(tmux.dispatched).toHaveLength(1);
      expect(tmux.dispatched[0]!.globalArgs).toEqual(["-S/tmp/fake"]);
      expect(tmux.dispatched[0]!.commands[0]![2]).toBe("#{==:#{version},3.8}");
    },
  );

  test.each(["3.2a", "3.3"])("never starts a %s executable's server", async (client) => {
    const tmux = new FakeTmux(undefined);
    tmux.client = client;
    const failure = await new VersionCheckTransport(tmux)
      .execute(request({ commands: [["new-session", "-d"]] }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VersionTooLowError);
    expect(tmux.dispatched).toHaveLength(0);
  });

  test("accepts the executable name 3.3a prints in place of tmux", async () => {
    const tmux = new FakeTmux(undefined);
    tmux.client = "3.3a";
    tmux.clientName = "tmux-3.3a";
    const transport = new VersionCheckTransport(tmux);
    await transport.execute(
      request({ executable: "/opt/tmux-3.3a", commands: [["new-session", "-d"]] }),
    );
    expect(tmux.dispatched).toHaveLength(1);
  });

  test("passes client diagnostics through untouched", async () => {
    const tmux = new FakeTmux("3.2a");
    const result = await new VersionCheckTransport(tmux).execute(
      request({ globalArgs: ["-V"], commands: [["display-message", "-p", "x"]] }),
    );
    expect(decoder.decode(result.stdout)).toBe("tmux 3.7d\n");
    expect(tmux.probes).toHaveLength(0);
  });

  test("keeps a probe's supported answer for the commands that follow", async () => {
    const tmux = new FakeTmux("3.8");
    const transport = new VersionCheckTransport(tmux);
    const { request: probe } = daemonProbe({
      executable: "/usr/bin/tmux",
      globalArgs: ["-S/tmp/fake"],
    });

    await transport.execute(probe);
    await transport.execute(request());

    expect(tmux.probes).toHaveLength(1);
  });

  test("carries the caller's stdin on the one command after the fence", async () => {
    const tmux = new FakeTmux("3.3a");
    const transport = new VersionCheckTransport(tmux);
    await transport.execute(
      request({ commands: [["load-buffer", "-b", "x", "-"]], stdin: new Uint8Array([1, 2]) }),
    );
    expect(tmux.dispatched[0]!.stdin).toEqual(new Uint8Array([1, 2]));
  });

  test("reports a version-check timeout as not started", async () => {
    const tmux = new FakeTmux("3.8");
    const slow: CommandTransport = {
      async execute(probe) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return tmux.execute(probe);
      },
    };
    const failure = await new VersionCheckTransport(slow)
      .execute(request({ timeoutMs: 10 }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TmuxTransportError);
    expect(failure).toMatchObject({ delivery: "not_started", kind: "timeout" });
    expect(tmux.dispatched).toHaveLength(0);
  });

  test("refuses a cancelled request before it asks tmux anything", async () => {
    const tmux = new FakeTmux("3.8");
    const controller = new AbortController();
    controller.abort();
    const failure = await new VersionCheckTransport(tmux)
      .execute(request({ signal: controller.signal }))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ delivery: "not_started", kind: "cancelled" });
    expect(tmux.requests).toHaveLength(0);
  });
});
