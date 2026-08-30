import { randomUUID } from "node:crypto";

const decoder = new TextDecoder("utf-8", { fatal: false });

/** An unknown tmux command whose name cannot be configured ahead of time. */
export function uniqueUnknownCommand(reason: string): string {
  return `libtmux-${reason}-${randomUUID().replaceAll("-", "")}`;
}

/** Whether tmux failed by rejecting this exact unknown command. */
export function refusedUnknownCommand(
  command: string,
  returncode: number,
  stderr: Uint8Array,
): boolean {
  if (returncode === 0) return false;
  const expected = `unknown command: ${command}`;
  return decoder.decode(stderr).split(/\r?\n/u).includes(expected);
}
