import type { BarrierConfig } from "../fixtures/fake_tmux/barrier.js";
import type { ElsewhereConfig } from "../fixtures/fake_tmux/elsewhere.js";
import type { IgnoreTermConfig } from "../fixtures/fake_tmux/ignore_term.js";
import type { LaunchConfig } from "../fixtures/fake_tmux/launch.js";
import type { ProbeConfig } from "../fixtures/fake_tmux/probe.js";
import type { ProxyConfig } from "../fixtures/fake_tmux/proxy.js";
import type { RecordingConfig } from "../fixtures/fake_tmux/recording.js";
import type { ReportVersionConfig } from "../fixtures/fake_tmux/report_version.js";
import type { StubConfig } from "../fixtures/fake_tmux/stub.js";

import { writeBunProgram } from "./bun_program.js";

export type { StubConfig };

/**
 * Executables that stand in for tmux, each a TypeScript program under
 * `fixtures/fake_tmux/` that Bun runs. A program that hands off to the real
 * tmux replaces itself with it, so its pid and signals are tmux's.
 */
const program = (name: string): URL => new URL(`../fixtures/fake_tmux/${name}.ts`, import.meta.url);

/** Runs the real tmux, logging calls and failing or stalling the ones the rules name. */
export function writeTmuxProxy(destination: string, config: ProxyConfig): Promise<string> {
  return writeBunProgram(destination, program("proxy"), config);
}

/** Records that it ran and exits with a status. */
export function writeProbe(destination: string, config: ProbeConfig): Promise<string> {
  return writeBunProgram(destination, program("probe"), config);
}

/** Records its inputs, announces itself and waits on a FIFO before running the real tmux. */
export function writeBarrier(destination: string, config: BarrierConfig): Promise<string> {
  return writeBunProgram(destination, program("barrier"), config);
}

/** Runs the real tmux with a launch frame that is held, slow to settle, wrong or for a gone server. */
export function writeLaunch(destination: string, config: LaunchConfig): Promise<string> {
  return writeBunProgram(destination, program("launch"), config);
}

/** Runs the real tmux and rewrites the version it reports. */
export function writeReportVersion(
  destination: string,
  config: ReportVersionConfig,
): Promise<string> {
  return writeBunProgram(destination, program("report_version"), config);
}

/** Records its start, ignores SIGTERM and never exits on its own. */
export function writeIgnoreTerm(destination: string, config: IgnoreTermConfig): Promise<string> {
  return writeBunProgram(destination, program("ignore_term"), config);
}

/** Runs the real tmux with `: > file` redirections dropped, as a tmux on another host would. */
export function writeElsewhere(destination: string, config: ElsewhereConfig): Promise<string> {
  return writeBunProgram(destination, program("elsewhere"), config);
}

/** Reaches no server; records which variables choose one into `trace`. */
export function writeRecording(destination: string, config: RecordingConfig): Promise<string> {
  return writeBunProgram(destination, program("recording"), config);
}

/** Answers `-S <socket> kill-server` as the test asked: exit, stop the server, or hang. */
export function writeStub(destination: string, config: StubConfig): Promise<string> {
  return writeBunProgram(destination, program("stub"), config);
}
