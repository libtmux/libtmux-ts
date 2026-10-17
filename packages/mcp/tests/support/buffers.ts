import { test } from "bun:test";

import { tmuxAtLeast } from "../../../libtmux/tests/support/tmux_release.js";

/** Named-buffer deletion, which `paste_text` and staged `run_shell_command` scripts rely on, needs tmux 3.4. */
export const testBuffers = tmuxAtLeast("3.4") ? test : test.skip;
