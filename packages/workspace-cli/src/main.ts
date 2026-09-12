#!/usr/bin/env node
// Node warns during module loading when both color variables are present.
if (process.env.NO_COLOR) delete process.env.FORCE_COLOR;
else if (process.env.NO_COLOR === "") delete process.env.NO_COLOR;

const controller = new AbortController();
let pipeClosed = false;
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      pipeClosed = true;
      controller.abort();
      process.exitCode = 141;
    } else throw error;
  });
const { run } = await import("./app.ts");
const exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  signal: controller.signal,
});
process.exitCode = pipeClosed ? 141 : controller.signal.aborted ? 130 : exitCode;
