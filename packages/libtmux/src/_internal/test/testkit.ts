/**
 * Supported repository-internal entrypoint for real-tmux fixtures and cleanup.
 *
 * This directory is excluded from the published package. Workspace packages,
 * scripts, tests, and examples import this module instead of its implementation
 * files so runtime responsibilities can move without changing every caller.
 */
export { reportSecondaryCleanupFailure, runWithCleanup } from "./cleanup.js";
export { ControlMode } from "./control_mode.js";
export type { ControlModeOptions } from "./control_mode.js";
export {
  CONTROL_REGISTRATION_DEADLINE_MS,
  DAEMON_EXIT_DEADLINE_MS,
  DAEMON_REAPED_DEADLINE_MS,
  deadlineMs,
  READINESS_DEADLINE_MS,
  READINESS_POLL_INTERVAL_MS,
  RESERVATION_RELEASE_DEADLINE_MS,
} from "./deadlines.js";
export {
  beginFixtureLaunch,
  promoteFixtureLaunch,
  reserveFixture,
  rollbackFixtureLaunchNotStarted,
} from "./fixture_launch.js";
export type {
  FixtureControllerRequest,
  LaunchAttemptCapability,
  ReservationCapability,
} from "./fixture_launch.js";
export {
  prepareRunRoot,
  reapFixture,
  reapOwnedRunRoot,
  reapStaleRunRoot,
  resolvePidfdInterpreter,
  sweepStaleRunRoots,
} from "./reaper.js";
export type { ReapReport } from "./reaper.js";
export { TEST_HANDLE_PROTOTYPES } from "./handle_prototypes.js";
export { resolveNode22 } from "./node22.js";
export {
  assertControllerCurrent,
  assertControllerIdentity,
  assertDaemonIdentity,
  assertIdentity,
  parseProcStatStartTime,
  readDaemonIdentity,
  readProcessIdentity,
  resolveControllerIdentity,
  sameControllerIdentity,
  sameDaemonIdentity,
} from "./process_identity.js";
export type { ControllerIdentity, DaemonIdentity, ProcessIdentity } from "./process_identity.js";
export {
  FIXTURE_RECORD_NAME,
  OWNER_RECORD_NAME,
  readFixtureRecord,
  SOCKET_PATH_UTF8_LIMIT,
  validateOwnedRecordMetadata,
  validateSocketPath,
} from "./records.js";
export type { FixtureRecord, LaunchGeneration, SocketIdentity } from "./records.js";
export { RUN_ROOT_ENV, runSupervisor, withOwnedRunRoot } from "./supervisor.js";
export type { SupervisorOptions } from "./supervisor.js";
export { assertOwnedSocketPath, makeTestDirectory } from "./temp_root.js";
export { TestServer } from "./test_server.js";
export type { TestServerOptions, TestServerRequestSnapshot } from "./test_server.js";
