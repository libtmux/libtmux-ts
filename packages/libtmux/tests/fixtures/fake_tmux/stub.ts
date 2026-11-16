import { readFileSync, writeFileSync } from "node:fs";

export type StubConfig =
  | { readonly behavior: "exit"; readonly code: number }
  | {
      /** Signals the server whose pid is recorded beside the socket, then returns. */
      readonly behavior: "stop";
    }
  | {
      /** Writes its own pid and a child's to `<pids>.child` and `<pids>.grandchild`, then waits. */
      readonly behavior: "hang";
      readonly pids: string;
    };

/** A tmux that is handed `-S <socket> kill-server` and does what the test asked of it. */
export default async function stub(config: StubConfig, argv: readonly string[]): Promise<number> {
  if (config.behavior === "exit") return config.code;
  if (config.behavior === "hang") {
    writeFileSync(`${config.pids}.child`, `${process.pid}\n`);
    const child = Bun.spawn(["sleep", "600"]);
    writeFileSync(`${config.pids}.grandchild`, `${child.pid}\n`);
    return child.exited;
  }
  process.kill(Number(readFileSync(`${argv[1] ?? ""}.pid`, "utf8")));
  return 0;
}
