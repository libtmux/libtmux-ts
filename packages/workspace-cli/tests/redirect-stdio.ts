// Runs a command with stdout and stderr in files and no stdin, while it keeps
// the controlling terminal this process was started on.
// usage: bun redirect-stdio.ts <stdout-file> <command> [argument...]
const [destination, ...argv] = process.argv.slice(2);
if (!destination || argv.length === 0) throw new Error("usage: redirect-stdio.ts FILE COMMAND...");
const child = Bun.spawn(argv, {
  stdin: "ignore",
  stdout: Bun.file(destination),
  stderr: Bun.file(`${destination}.err`),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
