import { spawnSync } from "node:child_process";

// A test that starts a server and walks away from it: on the default socket, or
// on `custom` inside the directory TMUX_TMPDIR names.
const tmpdir = process.env["TMUX_TMPDIR"];
if (tmpdir === undefined) throw new Error("TMUX_TMPDIR is not set");
const socket = process.argv[2] === "custom" ? ["-S", `${tmpdir}/custom.sock`] : [];
const started = spawnSync(
  "tmux",
  [...socket, "-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pid}", "sleep 600"],
  { encoding: "utf8" },
);
process.stdout.write(`leaked-server-pid ${started.stdout.trim()}\n`);
