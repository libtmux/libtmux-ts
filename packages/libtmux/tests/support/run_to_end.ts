import { spawn } from "node:child_process";

/** Run a command to its end without blocking the event loop, collecting what it prints. */
export function runToEnd(
  command: string,
  args: readonly string[],
  environment: Record<string, string | undefined>,
): Promise<{ readonly status: number | null; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout }));
  });
}
