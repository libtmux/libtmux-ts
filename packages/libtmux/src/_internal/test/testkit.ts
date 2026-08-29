/**
 * Supported repository-internal entrypoint for real-tmux fixtures and cleanup.
 *
 * This directory is excluded from the published package. Workspace packages,
 * scripts, tests, and examples import this module instead of its implementation
 * files so runtime responsibilities can move without changing every caller.
 */
export * from "./run_root.js";
export { reportSecondaryCleanupFailure, runWithCleanup } from "./cleanup.js";
