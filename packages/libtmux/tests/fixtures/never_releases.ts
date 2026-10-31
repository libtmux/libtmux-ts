import { spawn } from "node:child_process";

import { enterSandbox } from "../../src/_internal/test/testkit.js";

/** Run a command to its end, collecting what it prints. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("close", () => resolve(out.trim()));
  });
}

// Enters the sandbox, starts a server in it and exits without releasing; `stale` stops the
// server first, and `spaced` puts its socket at a path with a space.
const sandbox = await enterSandbox();
const socket = `${sandbox.root}/${process.argv[2] === "spaced" ? "my sock.sock" : "custom.sock"}`;
const pid = await run("tmux", [
  "-S",
  socket,
  "-f",
  "/dev/null",
  "new-session",
  "-d",
  "-P",
  "-F",
  "#{pid}",
  "sleep 600",
]);
if (process.argv[2] === "stale") await run("tmux", ["-S", socket, "kill-server"]);
process.stdout.write(`leaked-server-pid ${pid}\nsandbox-root ${sandbox.root}\n`);
