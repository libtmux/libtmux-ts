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
} from "./reaper.js";
export type { ReapReport } from "./reaper.js";
export {
  FIXTURE_RECORD_NAME,
  OWNER_RECORD_NAME,
  readFixtureRecord,
  SOCKET_PATH_UTF8_LIMIT,
  validateOwnedRecordMetadata,
  validateSocketPath,
} from "./records.js";
export type { FixtureRecord, LaunchGeneration, SocketIdentity } from "./records.js";
export { RUN_ROOT_ENV, runSupervisor } from "./supervisor.js";
export type { SupervisorOptions } from "./supervisor.js";
