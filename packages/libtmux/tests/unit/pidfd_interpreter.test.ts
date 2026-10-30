import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import { pidfdHelper, resolvePidfdInterpreter } from "../../src/_internal/test/testkit.js";

function proberFor(capable: ReadonlySet<string>, seen: string[]) {
  return async (executable: string): Promise<boolean> => {
    seen.push(executable);
    return capable.has(executable);
  };
}

const pidfdIdentityFixture = String.raw`
import ast, io, json, sys
from types import SimpleNamespace

source = ast.parse(sys.argv[1])
source.body = [node for node in source.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
program = compile(source, "<pidfd-helper-fixture>", "exec")
rows = []
for phase, field, events in [
    (phase, field, [])
    for phase in (1, 2, 3)
    for field in ("starttime", "comm", "executable", "argv", "generation")
] + [(3, "exit", events) for events in ([(91, 1)], [(91, 17)], [], [(91, 8)], [(91, 32)], [(91, 9)], [(91, 33)], [(91, 16)], [(92, 1)])] + [
    (phase, "zombie", []) for phase in (1, 2, 3)
]:
    state = {"reads": 0, "signals": [], "closed": [], "polls": []}
    boot = "00000000-0000-4000-8000-000000000000"
    expected = f"linux:{boot}:42"
    argv = ["/owned/tmux", "-S", "/owned/s", "start-server"]
    def changed(name):
        return field == name and state["reads"] == phase
    # Exited but not reaped: the stat line and start time stay, cmdline, environ and exe go.
    def zombie():
        return field == "zombie" and state["reads"] >= phase
    def open_proc(path, mode="r", encoding=None):
        if path == "/proc/17/comm":
            state["reads"] += 1
            value = "foreign" if changed("comm") else "tmux: server"
        elif path == "/proc/sys/kernel/random/boot_id":
            value = boot
        elif path == "/proc/17/stat":
            value = "17 (tmux: server) " + " ".join(["Z" if zombie() else "S"] + ["0"] * 18 + ["43" if changed("starttime") else "42"])
        elif path == "/proc/17/cmdline":
            value = b"" if zombie() else ("\0".join(["/foreign"] if changed("argv") else argv) + "\0").encode()
        elif path == "/proc/17/environ":
            value = b"" if zombie() else b"GEN=foreign\0" if changed("generation") else b"GEN=owned\0"
        else:
            raise AssertionError(path)
        return io.BytesIO(value) if "b" in mode else io.StringIO(value)
    def realpath(path):
        assert path == "/proc/17/exe"
        if changed("executable"):
            return "/foreign/tmux"
        return path if changed("exit") or zombie() else "/owned/tmux"
    class Poll:
        def register(self, descriptor, event):
            assert (descriptor, event) == (91, 1)
        def poll(self, timeout):
            state["polls"].append(timeout)
            assert timeout in (0, 500)
            return events if timeout == 0 else []
    def send(descriptor, signal):
        assert descriptor == 91 and signal == 15 and state["reads"] == 2
        state["signals"].append(signal)
    output = []
    namespace = {
        "json": json,
        "os": SimpleNamespace(path=SimpleNamespace(realpath=realpath), pidfd_open=lambda pid, flags: 91, close=state["closed"].append),
        "select": SimpleNamespace(poll=Poll, POLLIN=1, POLLERR=8, POLLNVAL=32),
        "signal": SimpleNamespace(SIGTERM=15, SIGKILL=9, pidfd_send_signal=send),
        "sys": SimpleNamespace(argv=["helper", "17", expected, "tmux: server", "/owned/tmux", json.dumps(argv), "GEN", "owned"]),
        "open": open_proc,
        "print": output.append,
    }
    code = 0
    try:
        exec(program, namespace)
    except SystemExit as error:
        code = error.code
    exited = field == "zombie" or (field == "exit" and events in ([(91, 1)], [(91, 17)]))
    assert code == (0 if exited else 3), (phase, field, events, code, output)
    assert json.loads(output[0])["status"] == ("gone" if exited else "identity-mismatch"), output
    assert state["signals"] == ([15] if phase == 3 else []), state
    assert state["closed"] == ([91] if phase > 1 else []), state
    rows.append([phase, field, events])
print(json.dumps(rows))
`;

describe("pidfd interpreter resolution", () => {
  test("accepts only authenticated pidfd exit readiness after TERM", () => {
    const result = spawnSync(
      process.env.LIBTMUX_TEST_PYTHON ?? "python3",
      ["-I", "-c", pidfdIdentityFixture, pidfdHelper],
      { encoding: "utf8", killSignal: "SIGKILL", timeout: 1000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(27);
  });

  test("selects the first candidate exposing pidfd_open", async () => {
    const seen: string[] = [];
    const resolved = await resolvePidfdInterpreter(
      ["free-threading-python", "/usr/bin/python3", "/opt/python3"],
      proberFor(new Set(["/usr/bin/python3", "/opt/python3"]), seen),
    );

    expect(resolved).toBe("/usr/bin/python3");
    expect(seen).toEqual(["free-threading-python", "/usr/bin/python3"]);
  });

  test("reports no interpreter when every candidate lacks pidfd_open", async () => {
    const seen: string[] = [];
    const resolved = await resolvePidfdInterpreter(
      ["python3", "/usr/bin/python3"],
      proberFor(new Set(), seen),
    );

    expect(resolved).toBeUndefined();
    expect(seen).toEqual(["python3", "/usr/bin/python3"]);
  });

  test("treats a probe failure as an unusable candidate rather than an error", async () => {
    const resolved = await resolvePidfdInterpreter(
      ["missing-python", "/usr/bin/python3"],
      (executable) => {
        if (executable === "missing-python") throw new Error("ENOENT");
        return Promise.resolve(true);
      },
    );

    expect(resolved).toBe("/usr/bin/python3");
  });

  test("resolves nothing when offered no candidates", async () => {
    expect(await resolvePidfdInterpreter([], () => Promise.resolve(true))).toBeUndefined();
  });
});
