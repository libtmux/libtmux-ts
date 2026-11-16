import { renameSync, writeFileSync } from "node:fs";

import { execProgram } from "../../support/bun_program.js";

export type LaunchConfig =
  | {
      readonly kind: "launch";
      readonly tmux: string;
      /** Receives the launch frame tmux printed. */
      readonly marker: string;
      /** What the wrapper does once the server is up and the frame is out. */
      readonly after: "exit" | "hold" | "move-socket" | "move-socket-and-hold";
      /** Where `move-socket` puts the server's socket. */
      readonly recoverySocket?: string;
      /** The wrapper's status; tmux's own when absent. */
      readonly exit?: number;
    }
  | {
      /** Prints a launch frame for a server that was never started, with this text as its pid. */
      readonly kind: "frame";
      readonly pid: string;
    };

/** Holds the process open with nothing to do, until it is killed. */
function hold(): Promise<never> {
  setInterval(() => undefined, 1 << 30);
  return new Promise<never>(() => undefined);
}

/** Output as a shell's command substitution reads it: without trailing newlines. */
function captured(tmux: string, args: readonly string[]): { output: string; status: number } {
  const result = Bun.spawnSync([tmux, ...args], { stderr: "inherit", stdout: "pipe" });
  return { output: result.stdout.toString().replace(/\n+$/u, ""), status: result.exitCode ?? 1 };
}

/** Moves the server's socket aside once its pane runs `cat`, so only a recovery socket reaches it. */
function moveSocket(config: LaunchConfig & { kind: "launch" }, output: string): number {
  const fields = output.split("\t");
  const [socket, , session] = fields;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const command = captured(config.tmux, [
      "-N",
      "-S",
      socket ?? "",
      "display-message",
      "-p",
      "-t",
      session ?? "",
      "#{pane_current_command}",
    ]).output;
    if (command === "cat") {
      renameSync(socket ?? "", config.recoverySocket ?? "");
      return 0;
    }
  }
  return 70;
}

/** The real tmux with a launch frame that is slow to settle, wrong, or for a server that is gone. */
export default async function launch(
  config: LaunchConfig,
  argv: readonly string[],
): Promise<number> {
  if (config.kind === "frame") {
    const socket = argv.flatMap((argument, index) => (argument === "-S" ? [argv[index + 1]] : []));
    process.stdout.write(`${socket.at(-1) ?? ""}\t${config.pid}\t$42\n`);
    return 0;
  }
  if (!` ${argv.join(" ")} `.includes(" new-session ")) return execProgram(config.tmux, argv);
  const { output, status } = captured(config.tmux, argv);
  process.stdout.write(`${output}\n`);
  writeFileSync(config.marker, `${output}\n`);
  if (config.after === "hold") return hold();
  if (config.after.startsWith("move-socket")) {
    const failure = moveSocket(config, output);
    if (failure !== 0) return failure;
    if (config.after === "move-socket-and-hold") return hold();
  }
  return config.exit ?? status;
}
