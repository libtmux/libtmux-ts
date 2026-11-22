import { appendFileSync } from "node:fs";
import { execProgram } from "../../support/bun_program.js";

export interface ProxyRule {
  /** A regular expression tested against the arguments joined by spaces. */
  readonly when: string;
  readonly stderr?: string;
  readonly exit?: number;
  /** Run the real tmux first, and fail afterwards. */
  readonly runFirst?: boolean;
  readonly sleepSeconds?: number;
  /** After the delay, run the real tmux as if no rule had matched. */
  readonly passThrough?: boolean;
}

export interface ProxyConfig {
  readonly tmux: string;
  /** Receives the arguments of every call, one line each. */
  readonly log?: string;
  readonly rules?: readonly ProxyRule[];
}

/** The real tmux behind a logger and a list of calls that fail or stall instead. */
export default async function proxy(config: ProxyConfig, argv: readonly string[]): Promise<number> {
  const line = argv.join(" ");
  if (config.log !== undefined) appendFileSync(config.log, `${line}\n`);
  const rule = config.rules?.find((candidate) => new RegExp(candidate.when, "u").test(line));
  if (rule !== undefined) {
    if (rule.runFirst === true) {
      await Bun.spawn([config.tmux, ...argv], { stdio: ["inherit", "inherit", "inherit"] }).exited;
    }
    if (rule.sleepSeconds !== undefined) await Bun.sleep(rule.sleepSeconds * 1000);
    if (rule.passThrough !== true) {
      if (rule.stderr !== undefined) process.stderr.write(`${rule.stderr}\n`);
      return rule.exit ?? 0;
    }
  }
  return execProgram(config.tmux, argv);
}
