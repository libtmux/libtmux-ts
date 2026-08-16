import type { ModelKindOf } from "./_internal/runtime/model_kind.js";
import { parseLegacyWhere as lowerLegacyWhere } from "./_internal/selection/legacy.js";

/**
 * A field's criteria accept its decoded shape as well as the text tmux sends:
 * `where({ active: true })` and `where({ active: "1" })` are the same query,
 * and serialize identically. `never` for a field that is text to begin with.
 */
type StringFilterFields<Value = never> = {
  readonly contains?: string;
  readonly endsWith?: string;
  readonly equals?: Value | string | null;
  readonly in?: readonly (Value | string)[];
  readonly mode?: "insensitive";
  readonly notIn?: readonly (Value | string)[];
  readonly regex?: RegexCriteriaData;
  readonly startsWith?: string;
};

type StringFilter<Value = never> = StringFilterFields<Value> &
  (
    | { readonly contains: string }
    | { readonly endsWith: string }
    | { readonly equals: Value | string | null }
    | { readonly in: readonly (Value | string)[] }
    | { readonly notIn: readonly (Value | string)[] }
    | { readonly regex: RegexCriteriaData }
    | { readonly startsWith: string }
  );

type ScalarCriteria<Value = never> = Value | string | null | StringFilter<Value>;

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
  readonly activeWindowIndex?: ScalarCriteria<number>;
  readonly activity?: ScalarCriteria<Date>;
  readonly alerts?: ScalarCriteria;
  readonly attached?: ScalarCriteria<number>;
  readonly attachedList?: ScalarCriteria;
  readonly created?: ScalarCriteria<Date>;
  readonly format?: ScalarCriteria<boolean>;
  readonly group?: ScalarCriteria;
  readonly groupAttached?: ScalarCriteria<number>;
  readonly groupAttachedList?: ScalarCriteria;
  readonly groupList?: ScalarCriteria;
  readonly groupManyAttached?: ScalarCriteria<boolean>;
  readonly groupSize?: ScalarCriteria<number>;
  readonly grouped?: ScalarCriteria<boolean>;
  readonly id?: ScalarCriteria;
  readonly lastAttached?: ScalarCriteria<Date>;
  readonly lastWindowIndex?: ScalarCriteria<number>;
  readonly manyAttached?: ScalarCriteria<boolean>;
  readonly marked?: ScalarCriteria<boolean>;
  readonly name?: ScalarCriteria;
  readonly path?: ScalarCriteria;
  readonly sessionWindows?: ScalarCriteria<number>;
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
  readonly active?: ScalarCriteria<boolean>;
  readonly activeClients?: ScalarCriteria<number>;
  readonly activeClientsList?: ScalarCriteria;
  readonly activeSessions?: ScalarCriteria<number>;
  readonly activeSessionsList?: ScalarCriteria;
  readonly activity?: ScalarCriteria<Date>;
  readonly activityFlag?: ScalarCriteria<boolean>;
  readonly bellFlag?: ScalarCriteria<boolean>;
  readonly bigger?: ScalarCriteria<boolean>;
  readonly cellHeight?: ScalarCriteria<number>;
  readonly cellWidth?: ScalarCriteria<number>;
  readonly endFlag?: ScalarCriteria<boolean>;
  readonly flags?: ScalarCriteria;
  readonly format?: ScalarCriteria<boolean>;
  readonly height?: ScalarCriteria<number>;
  readonly id?: ScalarCriteria;
  readonly index?: ScalarCriteria<number>;
  readonly lastFlag?: ScalarCriteria<boolean>;
  readonly layout?: ScalarCriteria;
  readonly linked?: ScalarCriteria<boolean>;
  readonly linkedSessionsList?: ScalarCriteria;
  readonly markedFlag?: ScalarCriteria<boolean>;
  readonly name?: ScalarCriteria;
  readonly offsetX?: ScalarCriteria<number>;
  readonly offsetY?: ScalarCriteria<number>;
  readonly rawFlags?: ScalarCriteria;
  readonly silenceFlag?: ScalarCriteria<boolean>;
  readonly stackIndex?: ScalarCriteria<number>;
  readonly startFlag?: ScalarCriteria<boolean>;
  readonly visibleLayout?: ScalarCriteria;
  readonly width?: ScalarCriteria<number>;
  readonly windowLinkedSessions?: ScalarCriteria<number>;
  readonly windowPanes?: ScalarCriteria<number>;
  readonly zoomedFlag?: ScalarCriteria<boolean>;
  readonly session?: OneRelation<SessionWhere>;
  readonly linkedSessions?: ManyRelation<SessionWhere>;
  readonly panes?: ManyRelation<PaneWhere>;
  readonly activePane?: OneRelation<PaneWhere>;
}

export interface PaneWhere {
  readonly AND?: readonly PaneWhere[];
  readonly OR?: readonly PaneWhere[];
  readonly NOT?: readonly PaneWhere[];
  readonly active?: ScalarCriteria<boolean>;
  readonly alternateSavedX?: ScalarCriteria<number>;
  readonly alternateSavedY?: ScalarCriteria<number>;
  readonly atBottom?: ScalarCriteria<boolean>;
  readonly atLeft?: ScalarCriteria<boolean>;
  readonly atRight?: ScalarCriteria<boolean>;
  readonly atTop?: ScalarCriteria<boolean>;
  readonly bg?: ScalarCriteria;
  readonly bottom?: ScalarCriteria<number>;
  readonly bracketPasteFlag?: ScalarCriteria<boolean>;
  readonly currentCommand?: ScalarCriteria;
  readonly currentPath?: ScalarCriteria;
  readonly cursorCharacter?: ScalarCriteria;
  readonly cursorFlag?: ScalarCriteria<boolean>;
  readonly cursorX?: ScalarCriteria<number>;
  readonly cursorY?: ScalarCriteria<number>;
  readonly dead?: ScalarCriteria<boolean>;
  readonly deadSignal?: ScalarCriteria;
  readonly deadStatus?: ScalarCriteria<number>;
  readonly deadTime?: ScalarCriteria<Date>;
  readonly fg?: ScalarCriteria;
  readonly flags?: ScalarCriteria;
  readonly floatingFlag?: ScalarCriteria<boolean>;
  readonly format?: ScalarCriteria<boolean>;
  readonly height?: ScalarCriteria<number>;
  readonly historyBytes?: ScalarCriteria<number>;
  readonly historyLimit?: ScalarCriteria<number>;
  readonly historySize?: ScalarCriteria<number>;
  readonly id?: ScalarCriteria;
  readonly inMode?: ScalarCriteria<number>;
  readonly index?: ScalarCriteria<number>;
  readonly inputOff?: ScalarCriteria<boolean>;
  readonly insertFlag?: ScalarCriteria<boolean>;
  readonly keypadCursorFlag?: ScalarCriteria<boolean>;
  readonly keypadFlag?: ScalarCriteria<boolean>;
  readonly last?: ScalarCriteria<boolean>;
  readonly left?: ScalarCriteria<number>;
  readonly marked?: ScalarCriteria<boolean>;
  readonly markedSet?: ScalarCriteria<boolean>;
  readonly mode?: ScalarCriteria;
  readonly mouseAllFlag?: ScalarCriteria<boolean>;
  readonly mouseAnyFlag?: ScalarCriteria<boolean>;
  readonly mouseButtonFlag?: ScalarCriteria<boolean>;
  readonly mouseSgrFlag?: ScalarCriteria<boolean>;
  readonly mouseStandardFlag?: ScalarCriteria<boolean>;
  readonly originFlag?: ScalarCriteria<boolean>;
  readonly path?: ScalarCriteria;
  readonly pbProgress?: ScalarCriteria<number>;
  readonly pbState?: ScalarCriteria;
  readonly pid?: ScalarCriteria<number>;
  readonly pipe?: ScalarCriteria<boolean>;
  readonly pipePid?: ScalarCriteria<number>;
  readonly right?: ScalarCriteria<number>;
  readonly scrollRegionLower?: ScalarCriteria<number>;
  readonly scrollRegionUpper?: ScalarCriteria<number>;
  readonly searchString?: ScalarCriteria;
  readonly startCommand?: ScalarCriteria;
  readonly startPath?: ScalarCriteria;
  readonly synchronized?: ScalarCriteria<boolean>;
  readonly synchronizedOutputFlag?: ScalarCriteria<boolean>;
  readonly tabs?: ScalarCriteria;
  readonly title?: ScalarCriteria;
  readonly top?: ScalarCriteria<number>;
  readonly tty?: ScalarCriteria;
  readonly width?: ScalarCriteria<number>;
  readonly wrapFlag?: ScalarCriteria<boolean>;
  readonly x?: ScalarCriteria<number>;
  readonly y?: ScalarCriteria<number>;
  readonly z?: ScalarCriteria<number>;
  readonly zoomedFlag?: ScalarCriteria<boolean>;
  readonly window?: OneRelation<WindowWhere>;
  readonly session?: OneRelation<SessionWhere>;
}

export interface ClientWhere {
  readonly AND?: readonly ClientWhere[];
  readonly OR?: readonly ClientWhere[];
  readonly NOT?: readonly ClientWhere[];
  readonly activity?: ScalarCriteria<Date>;
  readonly cellHeight?: ScalarCriteria<number>;
  readonly cellWidth?: ScalarCriteria<number>;
  readonly clientSession?: ScalarCriteria;
  readonly controlMode?: ScalarCriteria<boolean>;
  readonly created?: ScalarCriteria<Date>;
  readonly discarded?: ScalarCriteria<number>;
  readonly flags?: ScalarCriteria;
  readonly height?: ScalarCriteria<number>;
  readonly keyTable?: ScalarCriteria;
  readonly lastSession?: ScalarCriteria;
  readonly modeFormat?: ScalarCriteria;
  readonly name?: ScalarCriteria;
  readonly pid?: ScalarCriteria<number>;
  readonly prefix?: ScalarCriteria<boolean>;
  readonly readonly?: ScalarCriteria<boolean>;
  readonly termfeatures?: ScalarCriteria;
  readonly termname?: ScalarCriteria;
  readonly termtype?: ScalarCriteria;
  readonly tty?: ScalarCriteria;
  readonly uid?: ScalarCriteria<number>;
  readonly user?: ScalarCriteria;
  readonly utf8?: ScalarCriteria<boolean>;
  readonly width?: ScalarCriteria<number>;
  readonly written?: ScalarCriteria<number>;
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
  /** Iterate in tmux's own order. Each call is a fresh iterator. */
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
