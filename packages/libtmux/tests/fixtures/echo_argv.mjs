import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--dual-streams") {
  const byteCount = Number.parseInt(args[1] ?? "0", 10);
  process.stdout.write(Buffer.alloc(byteCount, 0x6f));
  process.stderr.write(Buffer.alloc(byteCount, 0x65));
} else if (args[0] === "--echo-stdin") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(Buffer.concat(chunks));
} else if (args[0] === "--exit-with-inherited-pipe") {
  const markerPath = args[1];
  if (markerPath === undefined) throw new Error("marker path is required");
  const holdMs = Number.parseInt(args[2] ?? "500", 10);
  // The holder can print once the process that spawned it has exited.
  const lateMs = Number.parseInt(args[3] ?? "-1", 10);
  const late =
    lateMs < 0 ? "" : `setTimeout(() => process.stdout.write("late output\\n"), ${lateMs});`;
  const grandchild = spawn(
    process.execPath,
    ["--input-type=module", "--eval", `${late}setTimeout(() => {}, ${holdMs})`],
    {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  grandchild.unref();
  process.on("exit", () => writeFileSync(markerPath, String(grandchild.pid)));
} else {
  const exitArgument = args.find((argument) => argument.startsWith("--exit-code="));
  const echoedArgs = args.filter((argument) => argument !== exitArgument);
  process.stdout.write(`${JSON.stringify(echoedArgs)}\n`);
  process.stderr.write("fixture stderr\n");
  process.exitCode = exitArgument === undefined ? 0 : Number.parseInt(exitArgument.slice(12), 10);
}
