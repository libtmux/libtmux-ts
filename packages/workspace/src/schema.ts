/**
 * The zod schemas behind `./config`.
 *
 * This module is deliberately absent from the package's `exports` map. The
 * published types are plain TypeScript, so installing this package never makes
 * a consumer's `tsc` walk zod's own declarations; `tests/types/config.types.ts`
 * asserts the two never drift.
 */
import { z } from "zod";

import { OWNERSHIP_OPTION } from "./ownership.js";
import { isTmuxName } from "libtmux";

// The library refuses a name tmux would not store unchanged. Asking it here
// names the offending field instead of surfacing a TypeError from the call.
const NAME_MESSAGE = 'must not be empty or hold ":", ".", a control character, or DEL';

/**
 * Every object here is strict, and that is the point.
 *
 * A workspace is applied to a running server, so a key this schema does not
 * know is a key that will not happen — and `z.object` would drop it silently,
 * turning `window_nam: "editor"` into an unnamed window and a puzzled user.
 * Refusing the document is the only failure a caller can act on.
 */
export const paneSchema = z.union([
  z.string(),
  z.strictObject({
    focus: z.boolean().optional(),
    shell_command: z.union([z.string(), z.array(z.string())]).optional(),
    start_directory: z.string().optional(),
  }),
]);

export const optionValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const workspaceOptionsSchema = z
  .record(z.string(), optionValueSchema)
  .refine((options) => !Object.hasOwn(options, OWNERSHIP_OPTION), {
    message: `${OWNERSHIP_OPTION} is reserved for workspace ownership`,
  });

export const windowSchema = z.strictObject({
  focus: z.boolean().optional(),
  layout: z.string().optional(),
  options: z.record(z.string(), optionValueSchema).optional(),
  panes: z
    .array(paneSchema)
    .default([])
    .transform((panes) => (panes.length === 0 ? panes.concat({}) : panes)),
  shell_command_before: z.union([z.string(), z.array(z.string())]).optional(),
  start_directory: z.string().optional(),
  window_name: z.string().refine(isTmuxName, { message: NAME_MESSAGE }).optional(),
});

/**
 * A tmuxp-shaped workspace description.
 *
 * The field names follow tmuxp's snake_case config vocabulary rather than this
 * package's camelCase API, because the config is data a user already has on
 * disk. Renaming their keys to suit our API would break the very compatibility
 * the format is here to provide.
 */
export const workspaceSchema = z.strictObject({
  options: workspaceOptionsSchema.optional(),
  session_name: z.string().refine(isTmuxName, { message: NAME_MESSAGE }),
  start_directory: z.string().optional(),
  // A session always has at least one window, so a workspace with none does not
  // describe a reachable state: applying it would create a session and then try
  // to prune its windows to zero.
  windows: z.array(windowSchema).min(1),
});
