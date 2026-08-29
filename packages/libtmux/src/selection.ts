import { parseLegacyWhere as lowerLegacyWhere } from "./_internal/selection/legacy.js";
import type { Client } from "./client.js";
import type { PaneIdInput, SessionIdInput, WindowIdInput } from "./common.js";
import type { Pane } from "./pane.js";
import type { Server } from "./server.js";
import type { Session } from "./session.js";
import type { Window } from "./window.js";

type ModelKindOf<Model> = Model extends Client
  ? "client"
  : Model extends Pane
    ? "pane"
    : Model extends Server
      ? "server"
      : Model extends Session
        ? "session"
        : Model extends Window
          ? "window"
          : never;

/**
 * A field's criteria accept its decoded shape as well as the text tmux sends:
 * `where({ active: true })` and `where({ active: "1" })` are the same query,
 * and serialize identically.
 * A `null` criterion matches any wire value that the field decoder treats as
 * absent or invalid, rather than one particular wire spelling.
 *
 * The text side exists because the wire does. `encodeFormatValue` lowers every
 * criterion to tmux's text before a query is serialized, and
 * `WhereDocumentV1` types both what a caller writes and what
 * `decodeWhereDocument` gives back — so a type that refused text would be
 * lying about the documents this library's own encoder produces. That is the
 * difference from an ORM, whose query AST never round-trips through a type the
 * caller also authors.
 *
 * `Raw` is therefore not a taste. `"0" | "1"` is the exact wire domain for a
 * flag, while an integer uses `${bigint}` intersected with a decimal prefix.
 * That rules out fractions, exponents, radix prefixes, leading zeroes, `-0`,
 * `NaN`, and prose. TypeScript cannot bound an integer's magnitude, so the
 * query validator also requires safe range at runtime. `format_values.test.ts`
 * holds the layers in step.
 *
 * The substring operations stay `string` deliberately: `contains` asks about
 * the characters tmux sent, and a numeric field's text has characters like any
 * other.
 */
type StringFilterFields<Value = never, Raw extends string = string> = {
  readonly contains?: string;
  readonly endsWith?: string;
  readonly equals?: Value | Raw | null;
  readonly in?: readonly (Value | Raw)[];
  readonly mode?: "insensitive";
  readonly notIn?: readonly (Value | Raw)[];
  readonly regex?: RegexCriteriaData;
  readonly startsWith?: string;
};

type StringFilter<Value = never, Raw extends string = string> = StringFilterFields<Value, Raw> &
  (
    | { readonly contains: string }
    | { readonly endsWith: string }
    | { readonly equals: Value | Raw | null }
    | { readonly in: readonly (Value | Raw)[] }
    | { readonly notIn: readonly (Value | Raw)[] }
    | { readonly regex: RegexCriteriaData }
    | { readonly startsWith: string }
  );

type NonZeroDigit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/** The decimal text tmux sends for a field it reports as a number or timestamp. */
type RawNumber =
  | "0"
  | (`${bigint}` & `${NonZeroDigit}${string}`)
  | (`${bigint}` & `-${NonZeroDigit}${string}`);

/** The text tmux sends for a flag: it writes these two and nothing else. */
type RawFlag = "0" | "1";

type ScalarCriteria<Value = never, Raw extends string = string> =
  | Value
  | Raw
  | null
  | StringFilter<Value, Raw>;

type ManyRelation<Where> =
  | { readonly every?: Where; readonly none?: Where; readonly some: Where }
  | { readonly every: Where; readonly none?: Where; readonly some?: Where }
  | { readonly every?: Where; readonly none: Where; readonly some?: Where };

type OneRelation<Where> =
  | { readonly is: Where | null; readonly isNot?: Where | null }
  | { readonly is?: Where | null; readonly isNot: Where | null };

export interface RegexCriteriaData {
  readonly flags: "" | "m" | "s" | "ms";
  readonly pattern: string;
}

// <libtmux-generated-where-types>
export interface SessionWhere {
  readonly AND?: readonly SessionWhere[];
  readonly OR?: readonly SessionWhere[];
  readonly NOT?: readonly SessionWhere[];
  readonly active?: ScalarCriteria<boolean, RawFlag>;
  readonly activeWindowIndex?: ScalarCriteria<number, RawNumber>;
  readonly activity?: ScalarCriteria<Date, RawNumber>;
  readonly activityFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly alert?: ScalarCriteria;
  readonly alerts?: ScalarCriteria;
  readonly attached?: ScalarCriteria<number, RawNumber>;
  readonly attachedList?: ScalarCriteria;
  readonly bellFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly created?: ScalarCriteria<Date, RawNumber>;
  readonly format?: ScalarCriteria<boolean, RawFlag>;
  readonly group?: ScalarCriteria;
  readonly groupAttached?: ScalarCriteria<number, RawNumber>;
  readonly groupAttachedList?: ScalarCriteria;
  readonly groupList?: ScalarCriteria;
  readonly groupManyAttached?: ScalarCriteria<boolean, RawFlag>;
  readonly groupSize?: ScalarCriteria<number, RawNumber>;
  readonly grouped?: ScalarCriteria<boolean, RawFlag>;
  readonly id?: ScalarCriteria<SessionIdInput, never>;
  readonly lastAttached?: ScalarCriteria<Date, RawNumber>;
  readonly lastWindowIndex?: ScalarCriteria<number, RawNumber>;
  readonly manyAttached?: ScalarCriteria<boolean, RawFlag>;
  readonly marked?: ScalarCriteria<boolean, RawFlag>;
  readonly name?: ScalarCriteria;
  readonly path?: ScalarCriteria;
  readonly sessionWindows?: ScalarCriteria<number, RawNumber>;
  readonly silenceFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly stack?: ScalarCriteria;
  readonly windows?: ManyRelation<WindowWhere>;
  readonly panes?: ManyRelation<PaneWhere>;
  readonly activeWindow?: OneRelation<WindowWhere>;
  readonly activePane?: OneRelation<PaneWhere>;
}

export interface WindowWhere {
  readonly AND?: readonly WindowWhere[];
  readonly OR?: readonly WindowWhere[];
  readonly NOT?: readonly WindowWhere[];
  readonly active?: ScalarCriteria<boolean, RawFlag>;
  readonly activeClients?: ScalarCriteria<number, RawNumber>;
  readonly activeClientsList?: ScalarCriteria;
  readonly activeSessions?: ScalarCriteria<number, RawNumber>;
  readonly activeSessionsList?: ScalarCriteria;
  readonly activity?: ScalarCriteria<Date, RawNumber>;
  readonly activityFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly bellFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly bigger?: ScalarCriteria<boolean, RawFlag>;
  readonly cellHeight?: ScalarCriteria<number, RawNumber>;
  readonly cellWidth?: ScalarCriteria<number, RawNumber>;
  readonly endFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly flags?: ScalarCriteria;
  readonly format?: ScalarCriteria<boolean, RawFlag>;
  readonly height?: ScalarCriteria<number, RawNumber>;
  readonly id?: ScalarCriteria<WindowIdInput, never>;
  readonly index?: ScalarCriteria<number, RawNumber>;
  readonly lastFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly layout?: ScalarCriteria;
  readonly linked?: ScalarCriteria<boolean, RawFlag>;
  readonly linkedSessionsList?: ScalarCriteria;
  readonly markedFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly name?: ScalarCriteria;
  readonly offsetX?: ScalarCriteria<number, RawNumber>;
  readonly offsetY?: ScalarCriteria<number, RawNumber>;
  readonly rawFlags?: ScalarCriteria;
  readonly silenceFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly stackIndex?: ScalarCriteria<number, RawNumber>;
  readonly startFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly visibleLayout?: ScalarCriteria;
  readonly width?: ScalarCriteria<number, RawNumber>;
  readonly windowLinkedSessions?: ScalarCriteria<number, RawNumber>;
  readonly windowPanes?: ScalarCriteria<number, RawNumber>;
  readonly zoomedFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly session?: OneRelation<SessionWhere>;
  readonly linkedSessions?: ManyRelation<SessionWhere>;
  readonly panes?: ManyRelation<PaneWhere>;
  readonly activePane?: OneRelation<PaneWhere>;
}

export interface PaneWhere {
  readonly AND?: readonly PaneWhere[];
  readonly OR?: readonly PaneWhere[];
  readonly NOT?: readonly PaneWhere[];
  readonly active?: ScalarCriteria<boolean, RawFlag>;
  readonly alternateOn?: ScalarCriteria<boolean, RawFlag>;
  readonly alternateSavedX?: ScalarCriteria<number, RawNumber>;
  readonly alternateSavedY?: ScalarCriteria<number, RawNumber>;
  readonly atBottom?: ScalarCriteria<boolean, RawFlag>;
  readonly atLeft?: ScalarCriteria<boolean, RawFlag>;
  readonly atRight?: ScalarCriteria<boolean, RawFlag>;
  readonly atTop?: ScalarCriteria<boolean, RawFlag>;
  readonly bg?: ScalarCriteria;
  readonly bottom?: ScalarCriteria<number, RawNumber>;
  readonly bracketPasteFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly currentCommand?: ScalarCriteria;
  readonly currentPath?: ScalarCriteria;
  readonly cursorBlinking?: ScalarCriteria<boolean, RawFlag>;
  readonly cursorCharacter?: ScalarCriteria;
  readonly cursorColour?: ScalarCriteria;
  readonly cursorFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly cursorShape?: ScalarCriteria;
  readonly cursorVeryVisible?: ScalarCriteria<boolean, RawFlag>;
  readonly cursorX?: ScalarCriteria<number, RawNumber>;
  readonly cursorY?: ScalarCriteria<number, RawNumber>;
  readonly dead?: ScalarCriteria<boolean, RawFlag>;
  readonly deadSignal?: ScalarCriteria;
  readonly deadStatus?: ScalarCriteria<number, RawNumber>;
  readonly deadTime?: ScalarCriteria<Date, RawNumber>;
  readonly fg?: ScalarCriteria;
  readonly flags?: ScalarCriteria;
  readonly floatingFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly format?: ScalarCriteria<boolean, RawFlag>;
  readonly height?: ScalarCriteria<number, RawNumber>;
  readonly historyAllBytes?: ScalarCriteria;
  readonly historyBytes?: ScalarCriteria<number, RawNumber>;
  readonly historyLimit?: ScalarCriteria<number, RawNumber>;
  readonly historySize?: ScalarCriteria<number, RawNumber>;
  readonly id?: ScalarCriteria<PaneIdInput, never>;
  readonly inMode?: ScalarCriteria<number, RawNumber>;
  readonly index?: ScalarCriteria<number, RawNumber>;
  readonly inputOff?: ScalarCriteria<boolean, RawFlag>;
  readonly insertFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly keyMode?: ScalarCriteria;
  readonly keypadCursorFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly keypadFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly last?: ScalarCriteria<boolean, RawFlag>;
  readonly left?: ScalarCriteria<number, RawNumber>;
  readonly marked?: ScalarCriteria<boolean, RawFlag>;
  readonly markedSet?: ScalarCriteria<boolean, RawFlag>;
  readonly mode?: ScalarCriteria;
  readonly mouseAllFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly mouseAnyFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly mouseButtonFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly mouseSgrFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly mouseStandardFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly originFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly path?: ScalarCriteria;
  readonly pbProgress?: ScalarCriteria<number, RawNumber>;
  readonly pbState?: ScalarCriteria;
  readonly pid?: ScalarCriteria<number, RawNumber>;
  readonly pipe?: ScalarCriteria<boolean, RawFlag>;
  readonly pipePid?: ScalarCriteria<number, RawNumber>;
  readonly right?: ScalarCriteria<number, RawNumber>;
  readonly scrollRegionLower?: ScalarCriteria<number, RawNumber>;
  readonly scrollRegionUpper?: ScalarCriteria<number, RawNumber>;
  readonly searchString?: ScalarCriteria;
  readonly startCommand?: ScalarCriteria;
  readonly startPath?: ScalarCriteria;
  readonly synchronized?: ScalarCriteria<boolean, RawFlag>;
  readonly synchronizedOutputFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly tabs?: ScalarCriteria;
  readonly title?: ScalarCriteria;
  readonly top?: ScalarCriteria<number, RawNumber>;
  readonly tty?: ScalarCriteria;
  readonly unseenChanges?: ScalarCriteria<boolean, RawFlag>;
  readonly width?: ScalarCriteria<number, RawNumber>;
  readonly wrapFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly x?: ScalarCriteria<number, RawNumber>;
  readonly y?: ScalarCriteria<number, RawNumber>;
  readonly z?: ScalarCriteria<number, RawNumber>;
  readonly zoomedFlag?: ScalarCriteria<boolean, RawFlag>;
  readonly window?: OneRelation<WindowWhere>;
  readonly session?: OneRelation<SessionWhere>;
}

export interface ClientWhere {
  readonly AND?: readonly ClientWhere[];
  readonly OR?: readonly ClientWhere[];
  readonly NOT?: readonly ClientWhere[];
  readonly activity?: ScalarCriteria<Date, RawNumber>;
  readonly cellHeight?: ScalarCriteria<number, RawNumber>;
  readonly cellWidth?: ScalarCriteria<number, RawNumber>;
  readonly clientSession?: ScalarCriteria;
  readonly controlMode?: ScalarCriteria<boolean, RawFlag>;
  readonly created?: ScalarCriteria<Date, RawNumber>;
  readonly discarded?: ScalarCriteria<number, RawNumber>;
  readonly flags?: ScalarCriteria;
  readonly height?: ScalarCriteria<number, RawNumber>;
  readonly keyTable?: ScalarCriteria;
  readonly lastSession?: ScalarCriteria;
  readonly modeFormat?: ScalarCriteria;
  readonly name?: ScalarCriteria;
  readonly pid?: ScalarCriteria<number, RawNumber>;
  readonly prefix?: ScalarCriteria<boolean, RawFlag>;
  readonly readonly?: ScalarCriteria<boolean, RawFlag>;
  readonly termfeatures?: ScalarCriteria;
  readonly termname?: ScalarCriteria;
  readonly termtype?: ScalarCriteria;
  readonly tty?: ScalarCriteria;
  readonly uid?: ScalarCriteria<number, RawNumber>;
  readonly user?: ScalarCriteria;
  readonly utf8?: ScalarCriteria<boolean, RawFlag>;
  readonly width?: ScalarCriteria<number, RawNumber>;
  readonly written?: ScalarCriteria<number, RawNumber>;
  readonly session?: OneRelation<SessionWhere>;
  readonly window?: OneRelation<WindowWhere>;
  readonly pane?: OneRelation<PaneWhere>;
}

// </libtmux-generated-where-types>

type WhereForKind<Kind> = Kind extends "session"
  ? SessionWhere
  : Kind extends "window"
    ? WindowWhere
    : Kind extends "pane"
      ? PaneWhere
      : Kind extends "client"
        ? ClientWhere
        : never;

export type WhereOf<Model> = WhereForKind<ModelKindOf<Model>>;

/**
 * An immutable, ordered set of tmux objects read at one instant.
 *
 * A Selection is deliberately not an Array. It is `Iterable` and it never
 * changes, so the answer it gave a moment ago is still the answer now — which
 * is what lets a snapshot be reasoned about at all. `toArray()` is the one
 * crossing to array semantics, and everything Array offers that this does not
 * lives on the other side of it.
 *
 * Two ways to narrow, never overloaded into each other: `where` takes
 * declarative criteria that are data — serializable, inspectable, sendable over
 * a wire — and `filter` takes an ordinary predicate. Reach for `where` unless
 * the question genuinely needs to run code.
 */
export interface Selection<Model> extends Iterable<Model> {
  /**
   * How many members this holds. Unlike `count`, it takes no criteria.
   *
   * ```ts
   * snapshot.windows.length;
   * ```
   */
  readonly length: number;
  /**
   * Iterate in tmux's own order.
   *
   * Each call returns a fresh iterator, so a selection can be walked more than
   * once: spread it and then loop it, and the second pass is not empty. This is
   * what `for...of`, spread and destructuring all go through.
   *
   * ```ts
   * for (const window of snapshot.windows) window.name;
   * [...snapshot.windows].length === snapshot.windows.length;
   * ```
   */
  [Symbol.iterator](): IterableIterator<Model>;
  /**
   * The member at `index`, or undefined when the index is out of range.
   *
   * ```ts
   * snapshot.windows.at(0)?.name;
   * snapshot.windows.at(-1)?.name; // counts from the end
   * ```
   */
  at(index: number): Model | undefined;
  /**
   * A plain array of the members, in order.
   *
   * The crossing to array semantics: slicing, reversing, indexing, spreading.
   * The result is a copy, so mutating it cannot disturb the Selection.
   *
   * ```ts
   * const ordered = snapshot.panes.toArray();
   * ordered.slice(0, 2).map((entry) => entry.id);
   * ```
   */
  toArray(): Model[];
  /**
   * Apply `transform` to each member, in order.
   *
   * Returns an array rather than a Selection: the results are no longer tmux
   * objects, so they carry no identity to filter, count, or traverse from.
   *
   * ```ts
   * snapshot.windows.map((entry) => entry.name); // string[]
   * ```
   */
  map<Result>(
    transform: (value: Model, index: number, values: readonly Model[]) => Result,
    thisArg?: unknown,
  ): Result[];
  /**
   * Keep the members `predicate` accepts.
   *
   * For a question that has to run code. When the question can be expressed as
   * criteria, `where` says the same thing as data — which can be logged, sent
   * to another process, or stored.
   *
   * ```ts
   * snapshot.panes.filter((entry) => entry.currentCommand?.startsWith("v") === true);
   * ```
   */
  filter<Narrowed extends Model>(
    predicate: (value: Model, index: number, values: readonly Model[]) => value is Narrowed,
    thisArg?: unknown,
  ): Selection<Narrowed>;
  /**
   * Keep the members an ordinary predicate accepts without changing their type.
   *
   * ```ts
   * snapshot.panes.filter((entry) => entry.active === true);
   * ```
   */
  filter(
    predicate: (value: Model, index: number, values: readonly Model[]) => unknown,
    thisArg?: unknown,
  ): Selection<Model>;
  /**
   * Keep the members matching declarative criteria.
   *
   * Criteria are data: equality, string operators, `AND`/`OR`/`NOT`, regular
   * expressions expressed as `{ pattern, flags }`, and quantifiers over
   * relations. Matching is case-sensitive unless a criterion says otherwise.
   *
   * ```ts
   * snapshot.panes.where({ currentCommand: "vim" });
   * snapshot.windows.where({ name: { startsWith: "log" } });
   * ```
   *
   * @throws VersionTooLow when a criterion names a field newer than the tmux
   * that answered. Such a field is not absent from the data, it is absent from
   * that release, and matching it against nothing would answer "no member has
   * this" — which is a different statement and the one a caller would act on.
   * The error names the field, the release that has it, and the release
   * running.
   */
  where(criteria: WhereOf<Model>): Selection<Model>;
  /**
   * The first member, or the first matching `criteria`.
   *
   * Answers undefined for no match. Use this when zero is an ordinary outcome;
   * use `one` when it is not.
   *
   * ```ts
   * snapshot.windows.first({ name: "editor" })?.id;
   * ```
   */
  first(criteria?: WhereOf<Model>): Model | undefined;
  /**
   * The single member, or the single one matching `criteria`.
   *
   * Throws `NoMatchError` for none and `MultipleMatchesError` for several, so
   * "exactly one" is enforced rather than assumed — a `first` that silently
   * takes the head of two is how the wrong pane gets driven.
   *
   * An id is not always one member. A window linked into two sessions, or
   * shared by two grouped sessions, has a placement in each and both carry the
   * same id, so `one({ id })` raises for a perfectly good id. Add the session
   * to say which placement is meant.
   *
   * ```ts
   * const only = snapshot.sessions.one({ name: "work" });
   * only.id;
   * ```
   */
  one(criteria?: WhereOf<Model>): Model;
  /**
   * The single member, or undefined when there is none.
   *
   * `one` without the empty case: several still throws, because that says the
   * criteria were wrong rather than that the answer is absent.
   *
   * ```ts
   * snapshot.sessions.oneOrUndefined({ name: "work" })?.id;
   * ```
   */
  oneOrUndefined(criteria?: WhereOf<Model>): Model | undefined;
  /**
   * Whether anything matches. Cheaper to read than comparing a count to zero.
   *
   * ```ts
   * if (snapshot.windows.exists({ name: "build" })) {
   *   await session.selectWindow("build");
   * }
   * ```
   */
  exists(criteria?: WhereOf<Model>): boolean;
  /**
   * How many members match `criteria`, or how many there are without it.
   *
   * ```ts
   * snapshot.panes.count(); // every pane
   * snapshot.panes.count({ currentCommand: "vim" });
   * ```
   */
  count(criteria?: WhereOf<Model>): number;
}

export type WhereDocumentV1 =
  | { readonly model: "session"; readonly version: 1; readonly where: SessionWhere }
  | { readonly model: "window"; readonly version: 1; readonly where: WindowWhere }
  | { readonly model: "pane"; readonly version: 1; readonly where: PaneWhere }
  | { readonly model: "client"; readonly version: 1; readonly where: ClientWhere };

export function parseLegacyWhere<Model extends "session" | "window">(
  model: Model,
  input: unknown,
): Extract<WhereDocumentV1, { readonly model: Model }> {
  return lowerLegacyWhere(model, input);
}
