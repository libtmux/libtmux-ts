import { runSupervisor } from "../../src/_internal/test/testkit.js";

// Runs the command it is given the way a test runner does.
process.exitCode = await runSupervisor({ command: [process.execPath, ...process.argv.slice(2)] });
