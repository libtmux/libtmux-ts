import type { ModelKindOf } from "./_internal/runtime/model_kind.js";
import { parseLegacyWhere as lowerLegacyWhere } from "./_internal/selection/legacy.js";

type StringFilterFields = {
  readonly contains?: string;
  readonly endsWith?: string;
  readonly equals?: string | null;
  readonly in?: readonly string[];
  readonly mode?: "insensitive";
  readonly notIn?: readonly string[];
  readonly regex?: RegexCriteriaData;
  readonly startsWith?: string;
};

type StringFilter = StringFilterFields &
  (
    | { readonly contains: string }
    | { readonly endsWith: string }
    | { readonly equals: string | null }
    | { readonly in: readonly string[] }
    | { readonly notIn: readonly string[] }
    | { readonly regex: RegexCriteriaData }
    | { readonly startsWith: string }
  );

type ScalarCriteria = string | null | StringFilter;

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
  readonly activeWindowIndex?: ScalarCriteria;
  readonly activity?: ScalarCriteria;
  readonly alerts?: ScalarCriteria;
  readonly attached?: ScalarCriteria;
  readonly attachedList?: ScalarCriteria;
  readonly created?: ScalarCriteria;
  readonly format?: ScalarCriteria;
  readonly group?: ScalarCriteria;
  readonly groupAttached?: ScalarCriteria;
  readonly groupAttachedList?: ScalarCriteria;
  readonly groupList?: ScalarCriteria;
  readonly groupManyAttached?: ScalarCriteria;
  readonly groupSize?: ScalarCriteria;
  readonly grouped?: ScalarCriteria;
  readonly id?: ScalarCriteria;
  readonly lastAttached?: ScalarCriteria;
  readonly lastWindowIndex?: ScalarCriteria;
  readonly manyAttached?: ScalarCriteria;
  readonly marked?: ScalarCriteria;
  readonly name?: ScalarCriteria;
  readonly path?: ScalarCriteria;
  readonly sessionWindows?: ScalarCriteria;
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
  readonly active?: ScalarCriteria;
  readonly activeClients?: ScalarCriteria;
  readonly activeClientsList?: ScalarCriteria;
  readonly activeSessions?: ScalarCriteria;
  readonly activeSessionsList?: ScalarCriteria;
  readonly activity?: ScalarCriteria;
  readonly activityFlag?: ScalarCriteria;
  readonly bellFlag?: ScalarCriteria;
  readonly bigger?: ScalarCriteria;
  readonly cellHeight?: ScalarCriteria;
  readonly cellWidth?: ScalarCriteria;
  readonly endFlag?: ScalarCriteria;
  readonly flags?: ScalarCriteria;
  readonly format?: ScalarCriteria;
  readonly height?: ScalarCriteria;
  readonly id?: ScalarCriteria;
  readonly index?: ScalarCriteria;
  readonly lastFlag?: ScalarCriteria;
  readonly layout?: ScalarCriteria;
  readonly linked?: ScalarCriteria;
  readonly linkedSessionsList?: ScalarCriteria;
  readonly markedFlag?: ScalarCriteria;
  readonly name?: ScalarCriteria;
  readonly offsetX?: ScalarCriteria;
  readonly offsetY?: ScalarCriteria;
  readonly rawFlags?: ScalarCriteria;
  readonly silenceFlag?: ScalarCriteria;
  readonly stackIndex?: ScalarCriteria;
  readonly startFlag?: ScalarCriteria;
  readonly visibleLayout?: ScalarCriteria;
  readonly width?: ScalarCriteria;
  readonly windowLinkedSessions?: ScalarCriteria;
  readonly windowPanes?: ScalarCriteria;
  readonly zoomedFlag?: ScalarCriteria;
  readonly session?: OneRelation<SessionWhere>;
  readonly linkedSessions?: ManyRelation<SessionWhere>;
  readonly panes?: ManyRelation<PaneWhere>;
  readonly activePane?: OneRelation<PaneWhere>;
}

export interface PaneWhere {
  readonly AND?: readonly PaneWhere[];
  readonly OR?: readonly PaneWhere[];
  readonly NOT?: readonly PaneWhere[];
  readonly active?: ScalarCriteria;
  readonly alternateSavedX?: ScalarCriteria;
  readonly alternateSavedY?: ScalarCriteria;
  readonly atBottom?: ScalarCriteria;
  readonly atLeft?: ScalarCriteria;
  readonly atRight?: ScalarCriteria;
  readonly atTop?: ScalarCriteria;
  readonly bg?: ScalarCriteria;
  readonly bottom?: ScalarCriteria;
  readonly bracketPasteFlag?: ScalarCriteria;
  readonly currentCommand?: ScalarCriteria;
  readonly currentPath?: ScalarCriteria;
  readonly cursorCharacter?: ScalarCriteria;
  readonly cursorFlag?: ScalarCriteria;
  readonly cursorX?: ScalarCriteria;
  readonly cursorY?: ScalarCriteria;
  readonly dead?: ScalarCriteria;
  readonly deadSignal?: ScalarCriteria;
  readonly deadStatus?: ScalarCriteria;
  readonly deadTime?: ScalarCriteria;
  readonly fg?: ScalarCriteria;
  readonly flags?: ScalarCriteria;
  readonly floatingFlag?: ScalarCriteria;
  readonly format?: ScalarCriteria;
  readonly height?: ScalarCriteria;
  readonly historyBytes?: ScalarCriteria;
  readonly historyLimit?: ScalarCriteria;
  readonly historySize?: ScalarCriteria;
  readonly id?: ScalarCriteria;
  readonly inMode?: ScalarCriteria;
  readonly index?: ScalarCriteria;
  readonly inputOff?: ScalarCriteria;
  readonly insertFlag?: ScalarCriteria;
  readonly keypadCursorFlag?: ScalarCriteria;
  readonly keypadFlag?: ScalarCriteria;
  readonly last?: ScalarCriteria;
  readonly left?: ScalarCriteria;
  readonly marked?: ScalarCriteria;
  readonly markedSet?: ScalarCriteria;
  readonly mode?: ScalarCriteria;
  readonly mouseAllFlag?: ScalarCriteria;
  readonly mouseAnyFlag?: ScalarCriteria;
  readonly mouseButtonFlag?: ScalarCriteria;
  readonly mouseSgrFlag?: ScalarCriteria;
  readonly mouseStandardFlag?: ScalarCriteria;
  readonly originFlag?: ScalarCriteria;
  readonly path?: ScalarCriteria;
  readonly pbProgress?: ScalarCriteria;
  readonly pbState?: ScalarCriteria;
  readonly pid?: ScalarCriteria;
  readonly pipe?: ScalarCriteria;
  readonly pipePid?: ScalarCriteria;
  readonly right?: ScalarCriteria;
  readonly scrollRegionLower?: ScalarCriteria;
  readonly scrollRegionUpper?: ScalarCriteria;
  readonly searchString?: ScalarCriteria;
  readonly startCommand?: ScalarCriteria;
  readonly startPath?: ScalarCriteria;
  readonly synchronized?: ScalarCriteria;
  readonly synchronizedOutputFlag?: ScalarCriteria;
  readonly tabs?: ScalarCriteria;
  readonly title?: ScalarCriteria;
  readonly top?: ScalarCriteria;
  readonly tty?: ScalarCriteria;
  readonly width?: ScalarCriteria;
  readonly wrapFlag?: ScalarCriteria;
  readonly x?: ScalarCriteria;
  readonly y?: ScalarCriteria;
  readonly z?: ScalarCriteria;
  readonly zoomedFlag?: ScalarCriteria;
  readonly window?: OneRelation<WindowWhere>;
  readonly session?: OneRelation<SessionWhere>;
}

export interface ClientWhere {
  readonly AND?: readonly ClientWhere[];
  readonly OR?: readonly ClientWhere[];
  readonly NOT?: readonly ClientWhere[];
  readonly activity?: ScalarCriteria;
  readonly cellHeight?: ScalarCriteria;
  readonly cellWidth?: ScalarCriteria;
  readonly clientSession?: ScalarCriteria;
  readonly controlMode?: ScalarCriteria;
  readonly created?: ScalarCriteria;
  readonly discarded?: ScalarCriteria;
  readonly flags?: ScalarCriteria;
  readonly height?: ScalarCriteria;
  readonly keyTable?: ScalarCriteria;
  readonly lastSession?: ScalarCriteria;
  readonly modeFormat?: ScalarCriteria;
  readonly name?: ScalarCriteria;
  readonly pid?: ScalarCriteria;
  readonly prefix?: ScalarCriteria;
  readonly readonly?: ScalarCriteria;
  readonly termfeatures?: ScalarCriteria;
  readonly termname?: ScalarCriteria;
  readonly termtype?: ScalarCriteria;
  readonly tty?: ScalarCriteria;
  readonly uid?: ScalarCriteria;
  readonly user?: ScalarCriteria;
  readonly utf8?: ScalarCriteria;
  readonly width?: ScalarCriteria;
  readonly written?: ScalarCriteria;
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
