import { expect, test } from "bun:test";

import { afterSentKeysEcho } from "../../src/_internal/operations/pane_run.js";

test("skips the echo of the command before the printed remainder", () => {
  const command = "printf 'ltx-printed-ok\\n' # ltx-decoy-echo";
  const output = `${command}\nltx-printed-ok\n`;

  const after = afterSentKeysEcho(output, command);

  expect(after).toContain("ltx-printed-ok");
  expect(after).not.toContain("ltx-decoy-echo");
});

test("a marker that appears only in the command is not in the remainder", () => {
  const command = "true # ltx-decoy-echo";
  const output = `${command}\n$ `;

  expect(afterSentKeysEcho(output, command)).not.toContain("ltx-decoy-echo");
});

test("an incomplete echo line is not matched", () => {
  const command = "true # ltx-decoy-echo";
  const output = `${command}\r\n% \n❯ t\b${command}`;

  expect(afterSentKeysEcho(output, command)).not.toContain("ltx-decoy-echo");
});

test("output with no echo of the command is left intact once the line completes", () => {
  expect(afterSentKeysEcho("ltx-printed-ok\n", "printf 'ltx-printed-ok\\n'")).toBe(
    "ltx-printed-ok",
  );
});

test("a wrapped echo tail is not treated as printed output", () => {
  const command = "printf 'ltx-printed-ok\\n' # ltx-decoy-echo";
  const output = `${command}\n% \nprintf 'ltx-printed-ok\\n' \n # ltx-decoy-echo\nltx-printed-ok\n`;

  const after = afterSentKeysEcho(output, command);

  expect(after).toContain("ltx-printed-ok");
  expect(after).not.toContain("ltx-decoy-echo");
});
