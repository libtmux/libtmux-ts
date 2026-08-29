/**
 * Supported repository-internal entrypoint for real-tmux fixtures and cleanup.
 *
 * This directory is excluded from the published package. Workspace packages,
 * scripts, tests, and examples import this module instead of its implementation
 * files so runtime responsibilities can move without changing every caller.
 */
export { reportSecondaryCleanupFailure, runWithCleanup } from "./cleanup.js";
export {
  beginFixtureLaunch,
  FIXTURE_RECORD_NAME,
  OWNER_RECORD_NAME,
  prepareRunRoot,
  promoteFixtureLaunch,
  readFixtureRecord,
  reapFixture,
  reapOwnedRunRoot,
  reapStaleRunRoot,
  reserveFixture,
  resolvePidfdInterpreter,
  rollbackFixtureLaunchNotStarted,
  RUN_ROOT_ENV,
  SOCKET_PATH_UTF8_LIMIT,
  validateOwnedRecordMetadata,
  validateSocketPath,
} from "./run_root.js";
export type {
  FixtureControllerRequest,
  FixtureRecord,
  LaunchAttemptCapability,
  LaunchGeneration,
  ReapReport,
  ReservationCapability,
  SocketIdentity,
} from "./run_root.js";
export { runSupervisor } from "./supervisor.js";
export type { SupervisorOptions } from "./supervisor.js";
