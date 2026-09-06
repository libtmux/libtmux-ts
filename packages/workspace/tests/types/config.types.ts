// The published `./config` types are written by hand so that installing this
// package never makes a consumer's `tsc` walk zod's declarations — zod 4.5.4
// added core declarations that reference the `URL` global, which a consumer
// with neither `lib.dom` nor `@types/node` cannot resolve.
//
// Hand-written types can drift from the schemas that validate at runtime, so
// every published type is pinned here to the shape zod infers. A schema change
// that is not mirrored in `src/config.ts` fails this file, and the build.
//
// Not named `*.test.ts`: it asserts at compile time and has no cases to run.
import type {
  Workspace,
  WorkspaceInput,
  WorkspaceOptionValue,
  WorkspacePane,
  WorkspaceWindow,
  WorkspaceWindowInput,
} from "../../src/config.js";
import type {
  optionValueSchema,
  paneSchema,
  windowSchema,
  workspaceSchema,
} from "../../src/schema.js";
import type { z } from "zod";

type Equal<Actual, Expected> =
  (<Type>() => Type extends Actual ? 1 : 2) extends <Type>() => Type extends Expected ? 1 : 2
    ? true
    : false;

type Expect<Value extends true> = Value;

export type WorkspaceMatchesSchema = Expect<Equal<Workspace, z.output<typeof workspaceSchema>>>;
export type WorkspaceInputMatchesSchema = Expect<
  Equal<WorkspaceInput, z.input<typeof workspaceSchema>>
>;
export type WindowMatchesSchema = Expect<Equal<WorkspaceWindow, z.output<typeof windowSchema>>>;
export type WindowInputMatchesSchema = Expect<
  Equal<WorkspaceWindowInput, z.input<typeof windowSchema>>
>;
export type PaneMatchesSchema = Expect<Equal<WorkspacePane, z.output<typeof paneSchema>>>;
export type OptionValueMatchesSchema = Expect<
  Equal<WorkspaceOptionValue, z.output<typeof optionValueSchema>>
>;
