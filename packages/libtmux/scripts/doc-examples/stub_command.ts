/** What a stand-in for a command the examples name does. */
export interface StubCommand {
  /** A line to print, as the real command would. */
  readonly print?: string;
  /** Stay running, as a dev server or a pager does, until the pane is killed. */
  readonly stayUp?: boolean;
}

/**
 * A command the examples name and a machine cannot be assumed to have, written
 * with `writeBunProgram` so the stand-in is TypeScript and not a shell script.
 */
export default async function stubCommand(config: StubCommand): Promise<number> {
  if (config.print !== undefined) process.stdout.write(`${config.print}\n`);
  if (config.stayUp === true) await Bun.sleep(600_000);
  return 0;
}
