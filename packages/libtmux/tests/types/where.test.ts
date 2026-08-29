import { Client } from "../../src/client.js";
import type { PaneId, PaneIdInput, SafeInteger, SessionId, WindowId } from "../../src/common.js";
import { WHERE_RELATIONS_V1 } from "../../src/_generated/where_fields.js";
import { Pane } from "../../src/pane.js";
import { Session } from "../../src/session.js";
import { Window } from "../../src/window.js";
import {
  decodeWhereDocument,
  encodeWhereDocument,
} from "../../src/_internal/selection/serialization.js";
import {
  parseLegacyWhere,
  type ClientWhere,
  type PaneWhere,
  type RegexCriteriaData,
  type Selection,
  type SessionWhere,
  type WhereDocumentV1,
  type WhereOf,
  type WindowWhere,
} from "../../src/selection.js";
import type { Equal, Expect } from "./assert.js";

type ManyRelation<Where> =
  | { readonly every?: Where; readonly none?: Where; readonly some: Where }
  | { readonly every: Where; readonly none?: Where; readonly some?: Where }
  | { readonly every?: Where; readonly none: Where; readonly some?: Where };

type OneRelation<Where> =
  | { readonly is: Where | null; readonly isNot?: Where | null }
  | { readonly is?: Where | null; readonly isNot: Where | null };

type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

type ExpectedStringFilterFields<Value = never, Raw extends string = string> = {
  readonly contains?: string;
  readonly endsWith?: string;
  readonly equals?: Value | Raw | null;
  readonly in?: readonly (Value | Raw)[];
  readonly mode?: "insensitive";
  readonly notIn?: readonly (Value | Raw)[];
  readonly regex?: { readonly flags: "" | "m" | "ms" | "s"; readonly pattern: string };
  readonly startsWith?: string;
};

type ExpectedStringFilter<Value = never, Raw extends string = string> = ExpectedStringFilterFields<
  Value,
  Raw
> &
  (
    | { readonly contains: string }
    | { readonly endsWith: string }
    | { readonly equals: Value | Raw | null }
    | { readonly in: readonly (Value | Raw)[] }
    | { readonly notIn: readonly (Value | Raw)[] }
    | {
        readonly regex: {
          readonly flags: "" | "m" | "ms" | "s";
          readonly pattern: string;
        };
      }
    | { readonly startsWith: string }
  );

type ExpectedScalarCriteria<Value = never, Raw extends string = string> =
  | Value
  | Raw
  | null
  | ExpectedStringFilter<Value, Raw>
  | undefined;

type ExpectedNonZeroDigit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type ExpectedRawNumber =
  | "0"
  | (`${bigint}` & `${ExpectedNonZeroDigit}${string}`)
  | (`${bigint}` & `-${ExpectedNonZeroDigit}${string}`);

/**
 * Every scalar criteria still accepts the text tmux sends for that field.
 *
 * Not any text: a numeric field takes `"3"` and refuses `"banana"`. What must
 * not change is that the text form works at all, since it is what a stored
 * query and a raw tmux value both arrive as.
 */
type AllScalarCriteriaAcceptTheirText<Where, Keys extends keyof Where> = {
  [Key in Keys]-?: [ExpectedScalarCriteria<never, "0">, Where[Key]] extends [Where[Key], unknown]
    ? true
    : false;
}[Keys];
type WritableKeys<Value> = {
  [Key in keyof Value]-?: Equal<Pick<Value, Key>, Readonly<Pick<Value, Key>>> extends true
    ? never
    : Key;
}[keyof Value];

type ExpectedDocument =
  | { readonly model: "session"; readonly version: 1; readonly where: SessionWhere }
  | { readonly model: "window"; readonly version: 1; readonly where: WindowWhere }
  | { readonly model: "pane"; readonly version: 1; readonly where: PaneWhere }
  | { readonly model: "client"; readonly version: 1; readonly where: ClientWhere };

type _Document = Expect<Equal<WhereDocumentV1, ExpectedDocument>>;
type _DecodeDocument = Expect<
  Equal<typeof decodeWhereDocument, (input: unknown) => WhereDocumentV1>
>;
type _EncodeDocument = Expect<
  Equal<typeof encodeWhereDocument, (document: WhereDocumentV1) => string>
>;
declare const decodedPaneDocument: Extract<WhereDocumentV1, { readonly model: "pane" }>;
void decodedPaneDocument.where.title;
// @ts-expect-error Decoded documents expose criteria names, not wire names.
void decodedPaneDocument.where.pane_title;
type _Regex = Expect<
  Equal<RegexCriteriaData, { readonly flags: "" | "m" | "s" | "ms"; readonly pattern: string }>
>;
type _SessionWindows = Expect<
  Equal<NonNullable<SessionWhere["windows"]>, ManyRelation<WindowWhere>>
>;
type _SessionPanes = Expect<Equal<NonNullable<SessionWhere["panes"]>, ManyRelation<PaneWhere>>>;
type _SessionActiveWindow = Expect<
  Equal<NonNullable<SessionWhere["activeWindow"]>, OneRelation<WindowWhere>>
>;
type _SessionActivePane = Expect<
  Equal<NonNullable<SessionWhere["activePane"]>, OneRelation<PaneWhere>>
>;
type _WindowSession = Expect<Equal<NonNullable<WindowWhere["session"]>, OneRelation<SessionWhere>>>;
type _WindowLinkedSessions = Expect<
  Equal<NonNullable<WindowWhere["linkedSessions"]>, ManyRelation<SessionWhere>>
>;
type _WindowPanes = Expect<Equal<NonNullable<WindowWhere["panes"]>, ManyRelation<PaneWhere>>>;
type _WindowActivePane = Expect<
  Equal<NonNullable<WindowWhere["activePane"]>, OneRelation<PaneWhere>>
>;
type _PaneWindow = Expect<Equal<NonNullable<PaneWhere["window"]>, OneRelation<WindowWhere>>>;
type _PaneSession = Expect<Equal<NonNullable<PaneWhere["session"]>, OneRelation<SessionWhere>>>;
type _SessionAnd = Expect<Equal<NonNullable<SessionWhere["AND"]>, readonly SessionWhere[]>>;
type _SessionOr = Expect<Equal<NonNullable<SessionWhere["OR"]>, readonly SessionWhere[]>>;
type _SessionNot = Expect<Equal<NonNullable<SessionWhere["NOT"]>, readonly SessionWhere[]>>;
type _WindowAnd = Expect<Equal<NonNullable<WindowWhere["AND"]>, readonly WindowWhere[]>>;
type _WindowOr = Expect<Equal<NonNullable<WindowWhere["OR"]>, readonly WindowWhere[]>>;
type _WindowNot = Expect<Equal<NonNullable<WindowWhere["NOT"]>, readonly WindowWhere[]>>;
type _PaneAnd = Expect<Equal<NonNullable<PaneWhere["AND"]>, readonly PaneWhere[]>>;
type _PaneOr = Expect<Equal<NonNullable<PaneWhere["OR"]>, readonly PaneWhere[]>>;
type _PaneNot = Expect<Equal<NonNullable<PaneWhere["NOT"]>, readonly PaneWhere[]>>;

type LogicalKeys = "AND" | "NOT" | "OR";
type SessionRelationKeys = "activePane" | "activeWindow" | "panes" | "windows";
type WindowRelationKeys = "activePane" | "linkedSessions" | "panes" | "session";
type PaneRelationKeys = "session" | "window";
type SessionScalarKeys = Exclude<keyof SessionWhere, LogicalKeys | SessionRelationKeys>;
type WindowScalarKeys = Exclude<keyof WindowWhere, LogicalKeys | WindowRelationKeys>;
type PaneScalarKeys = Exclude<keyof PaneWhere, LogicalKeys | PaneRelationKeys>;
type ExpectedSessionScalarKeys =
  | "active"
  | "activeWindowIndex"
  | "activity"
  | "activityFlag"
  | "alert"
  | "alerts"
  | "attached"
  | "attachedList"
  | "bellFlag"
  | "created"
  | "format"
  | "group"
  | "groupAttached"
  | "groupAttachedList"
  | "groupList"
  | "groupManyAttached"
  | "groupSize"
  | "grouped"
  | "id"
  | "lastAttached"
  | "lastWindowIndex"
  | "manyAttached"
  | "marked"
  | "name"
  | "path"
  | "sessionWindows"
  | "silenceFlag"
  | "stack";
type ExpectedWindowScalarKeys =
  | "active"
  | "activeClients"
  | "activeClientsList"
  | "activeSessions"
  | "activeSessionsList"
  | "activity"
  | "activityFlag"
  | "bellFlag"
  | "bigger"
  | "cellHeight"
  | "cellWidth"
  | "endFlag"
  | "flags"
  | "format"
  | "height"
  | "id"
  | "index"
  | "lastFlag"
  | "layout"
  | "linked"
  | "linkedSessionsList"
  | "markedFlag"
  | "name"
  | "offsetX"
  | "offsetY"
  | "rawFlags"
  | "silenceFlag"
  | "stackIndex"
  | "startFlag"
  | "visibleLayout"
  | "width"
  | "windowLinkedSessions"
  | "windowPanes"
  | "zoomedFlag";
type ExpectedPaneScalarKeys =
  | "active"
  | "alternateOn"
  | "alternateSavedX"
  | "alternateSavedY"
  | "atBottom"
  | "atLeft"
  | "atRight"
  | "atTop"
  | "bg"
  | "bottom"
  | "bracketPasteFlag"
  | "currentCommand"
  | "currentPath"
  | "cursorBlinking"
  | "cursorCharacter"
  | "cursorColour"
  | "cursorFlag"
  | "cursorShape"
  | "cursorVeryVisible"
  | "cursorX"
  | "cursorY"
  | "dead"
  | "deadSignal"
  | "deadStatus"
  | "deadTime"
  | "fg"
  | "flags"
  | "floatingFlag"
  | "format"
  | "height"
  | "historyAllBytes"
  | "historyBytes"
  | "historyLimit"
  | "historySize"
  | "id"
  | "inMode"
  | "index"
  | "inputOff"
  | "insertFlag"
  | "keyMode"
  | "keypadCursorFlag"
  | "keypadFlag"
  | "last"
  | "left"
  | "marked"
  | "markedSet"
  | "mode"
  | "mouseAllFlag"
  | "mouseAnyFlag"
  | "mouseButtonFlag"
  | "mouseSgrFlag"
  | "mouseStandardFlag"
  | "originFlag"
  | "path"
  | "pbProgress"
  | "pbState"
  | "pid"
  | "pipe"
  | "pipePid"
  | "right"
  | "scrollRegionLower"
  | "scrollRegionUpper"
  | "searchString"
  | "startCommand"
  | "startPath"
  | "synchronized"
  | "synchronizedOutputFlag"
  | "tabs"
  | "title"
  | "top"
  | "tty"
  | "unseenChanges"
  | "width"
  | "wrapFlag"
  | "x"
  | "y"
  | "z"
  | "zoomedFlag";
type _SessionScalarKeys = Expect<Equal<SessionScalarKeys, ExpectedSessionScalarKeys>>;
type _WindowScalarKeys = Expect<Equal<WindowScalarKeys, ExpectedWindowScalarKeys>>;
type _PaneScalarKeys = Expect<Equal<PaneScalarKeys, ExpectedPaneScalarKeys>>;
type _SessionScalarShapes = Expect<
  Equal<AllScalarCriteriaAcceptTheirText<SessionWhere, SessionScalarKeys>, true>
>;
type _WindowScalarShapes = Expect<
  Equal<AllScalarCriteriaAcceptTheirText<WindowWhere, WindowScalarKeys>, true>
>;
type _PaneScalarShapes = Expect<
  Equal<AllScalarCriteriaAcceptTheirText<PaneWhere, PaneScalarKeys>, true>
>;

// A field tmux answers with text stays text.
type _StringDomain = Expect<MutuallyAssignable<SessionWhere["name"], ExpectedScalarCriteria>>;
// A field this port knows the shape of takes that shape too, and only that one.
type _BooleanDomain = Expect<
  MutuallyAssignable<PaneWhere["active"], ExpectedScalarCriteria<boolean, "0" | "1">>
>;
type _NumberDomain = Expect<
  MutuallyAssignable<PaneWhere["pid"], ExpectedScalarCriteria<SafeInteger, ExpectedRawNumber>>
>;
type _TimeDomain = Expect<
  MutuallyAssignable<SessionWhere["created"], ExpectedScalarCriteria<Date, ExpectedRawNumber>>
>;

// The narrowing is the point: text that could never be this field's value is
// refused, where before every field took every string.
type _NumberRefusesProse = Expect<Equal<"banana" extends PaneWhere["pid"] ? true : false, false>>;
type _FlagRefusesProse = Expect<Equal<"yes" extends PaneWhere["active"] ? true : false, false>>;
type _NumberTakesItsText = Expect<Equal<"4321" extends PaneWhere["pid"] ? true : false, true>>;
type _NumberRefusesFractionText = Expect<
  Equal<"1.5" extends PaneWhere["pid"] ? true : false, false>
>;
type _NumberRefusesExponentText = Expect<
  Equal<"1e+21" extends PaneWhere["pid"] ? true : false, false>
>;
type _NumberRefusesNaNText = Expect<Equal<"NaN" extends PaneWhere["pid"] ? true : false, false>>;
type _NumberRefusesLeadingZero = Expect<Equal<"01" extends PaneWhere["pid"] ? true : false, false>>;
type _NumberRefusesHex = Expect<Equal<"0x1" extends PaneWhere["pid"] ? true : false, false>>;
type _NumberRefusesOctal = Expect<Equal<"0o1" extends PaneWhere["pid"] ? true : false, false>>;
type _NumberRefusesBinary = Expect<Equal<"0b1" extends PaneWhere["pid"] ? true : false, false>>;
type _NumberRefusesNegativeZero = Expect<
  Equal<"-0" extends PaneWhere["pid"] ? true : false, false>
>;
type _NumberTakesZero = Expect<Equal<"0" extends PaneWhere["pid"] ? true : false, true>>;
type _NumberTakesPositive = Expect<Equal<"42" extends PaneWhere["pid"] ? true : false, true>>;
type _NumberTakesNegative = Expect<Equal<"-42" extends PaneWhere["pid"] ? true : false, true>>;
type _NumberRefusesBareNumber = Expect<
  Equal<number extends PaneWhere["pid"] ? true : false, false>
>;
type _NumberTakesSafeInteger = Expect<
  Equal<SafeInteger extends PaneWhere["pid"] ? true : false, true>
>;
type _FlagTakesItsText = Expect<Equal<"1" extends PaneWhere["active"] ? true : false, true>>;
// A field tmux answers with text takes any of it, including text that looks
// numeric — `%1` is an id, not a number.
// An input accepts raw text for runtime authentication while preserving a
// brand carried by an already-authenticated id.
type _IdentityDomain = Expect<
  MutuallyAssignable<PaneWhere["id"], ExpectedScalarCriteria<PaneIdInput, never>>
>;
type _IdentityTakesRawText = Expect<Equal<string extends PaneWhere["id"] ? true : false, true>>;
type _IdentityTakesItsBrand = Expect<Equal<PaneId extends PaneWhere["id"] ? true : false, true>>;
type _IdentityRefusesSessionBrand = Expect<
  Equal<SessionId extends PaneWhere["id"] ? true : false, false>
>;
type _IdentityRefusesWindowBrand = Expect<
  Equal<WindowId extends PaneWhere["id"] ? true : false, false>
>;

type ActualStringFilter = Exclude<SessionWhere["name"], null | string | undefined>;
type _StringFilterShape = Expect<MutuallyAssignable<ActualStringFilter, ExpectedStringFilter>>;
type _StringFilterKeys = Expect<
  Equal<
    keyof ActualStringFilter,
    "contains" | "endsWith" | "equals" | "in" | "mode" | "notIn" | "regex" | "startsWith"
  >
>;
type _StringEquals = Expect<Equal<ActualStringFilter["equals"], null | string | undefined>>;
type _StringContains = Expect<Equal<ActualStringFilter["contains"], string | undefined>>;
type _StringEndsWith = Expect<Equal<ActualStringFilter["endsWith"], string | undefined>>;
type _StringIn = Expect<Equal<ActualStringFilter["in"], readonly string[] | undefined>>;
type _StringMode = Expect<Equal<ActualStringFilter["mode"], "insensitive" | undefined>>;
type _StringNotIn = Expect<Equal<ActualStringFilter["notIn"], readonly string[] | undefined>>;
type _StringRegex = Expect<
  Equal<
    ActualStringFilter["regex"],
    { readonly flags: "" | "m" | "ms" | "s"; readonly pattern: string } | undefined
  >
>;
type _StringStartsWith = Expect<Equal<ActualStringFilter["startsWith"], string | undefined>>;
type _StringFilterReadonly = Expect<Equal<WritableKeys<ActualStringFilter>, never>>;
type _SessionReadonly = Expect<Equal<WritableKeys<SessionWhere>, never>>;
type _WindowReadonly = Expect<Equal<WritableKeys<WindowWhere>, never>>;
type _PaneReadonly = Expect<Equal<WritableKeys<PaneWhere>, never>>;
type _NoModelMethods = Expect<Equal<Extract<keyof SessionWhere, "equals" | "server">, never>>;
type _NoDeprecatedChildren = Expect<Equal<Extract<keyof SessionWhere, "children">, never>>;
// Relations are exposed under idiomatic names; the tmux wire spellings are
// absent from the criteria surface entirely.
type _SessionCamelRelations = Expect<
  Equal<Extract<keyof SessionWhere, "activePane" | "activeWindow">, "activePane" | "activeWindow">
>;
type _NoSessionWireRelations = Expect<
  Equal<Extract<keyof SessionWhere, "active_pane" | "active_window">, never>
>;
type _NoWindowWireRelations = Expect<
  Equal<Extract<keyof WindowWhere, "active_pane" | "linked_sessions">, never>
>;
type _ClientIsQueryable = Expect<Equal<WhereOf<Client>, ClientWhere>>;
type _RelationModels = Expect<
  Equal<keyof typeof WHERE_RELATIONS_V1, "client" | "pane" | "session" | "window">
>;
type _SessionRelationMetadata = Expect<
  Equal<
    (typeof WHERE_RELATIONS_V1)["session"],
    readonly [
      { readonly cardinality: "many"; readonly name: "windows"; readonly targetModel: "window" },
      { readonly cardinality: "many"; readonly name: "panes"; readonly targetModel: "pane" },
      {
        readonly cardinality: "one";
        readonly name: "activeWindow";
        readonly targetModel: "window";
      },
      {
        readonly cardinality: "one";
        readonly name: "activePane";
        readonly targetModel: "pane";
      },
    ]
  >
>;

declare const sessions: Selection<Session>;
declare const windows: Selection<Window>;
declare const panes: Selection<Pane>;
declare const readonlySessionCriteria: SessionWhere;

const sessionCriteria: SessionWhere = {
  AND: [{ name: { contains: "a", mode: "insensitive", startsWith: "m" } }],
  NOT: [],
  OR: [{ name: null }, { name: { equals: null } }],
  activePane: {
    is: { title: { regex: { flags: "ms", pattern: "^(shell|tests)$" } } },
    isNot: null,
  },
  activeWindow: { is: null, isNot: { name: "logs" } },
  name: { contains: "a", endsWith: "n", notIn: [], startsWith: "m" },
  panes: {
    every: { title: { contains: "s" } },
    none: { title: "tail" },
    some: { title: "shell" },
  },
  windows: {
    every: {},
    none: { name: "logs" },
    some: { name: "editor" },
  },
};

const windowCriteria: WindowWhere = {
  activePane: { is: null },
  linkedSessions: { every: {}, none: { name: "other" }, some: { name: "main" } },
  panes: { some: {} },
  session: { is: { name: "main" }, isNot: null },
};

const paneCriteria: PaneWhere = {
  session: { is: { name: "main" } },
  window: { is: { name: "editor" }, isNot: null },
};

sessions.where(sessionCriteria);
windows.where(windowCriteria);
panes.where(paneCriteria);

const sessionDocument = parseLegacyWhere("session", { name__contains: "main" });
const windowDocument = parseLegacyWhere("window", { name__contains: "editor" });
sessions.where(sessionDocument.where);
windows.where(windowDocument.where);

// @ts-expect-error scalar comparison objects require at least one comparison.
sessions.where({ name: {} });
// @ts-expect-error generated criteria properties are readonly.
readonlySessionCriteria.name = "changed";
// @ts-expect-error mode alone is not a scalar comparison.
sessions.where({ name: { mode: "insensitive" } });
// @ts-expect-error contains does not accept null.
sessions.where({ name: { contains: null } });
// @ts-expect-error in does not accept null elements.
sessions.where({ name: { in: [null] } });
// @ts-expect-error insensitive is the sole mode.
sessions.where({ name: { equals: "main", mode: "ignore-case" } });
// @ts-expect-error regex flags are a closed canonical union.
sessions.where({ name: { regex: { flags: "sm", pattern: "main" } } });
// @ts-expect-error RegExp instances are not criteria data.
sessions.where({ name: /main/u });
// @ts-expect-error callbacks are not criteria data.
sessions.where({ name: () => "main" });
// @ts-expect-error logical operators accept arrays only.
sessions.where({ AND: { name: "main" } });
// @ts-expect-error many relation wrappers require at least one operator.
sessions.where({ windows: {} });
// @ts-expect-error one relation wrappers require at least one operator.
sessions.where({ active_window: {} });
// @ts-expect-error many relations do not accept null.
sessions.where({ windows: { some: null } });
// @ts-expect-error nested Window criteria reject Session-only fields.
sessions.where({ windows: { some: { session_id: "$1" } } });
// @ts-expect-error nested Pane criteria reject Window-only fields.
sessions.where({ panes: { some: { window_name: "editor" } } });
// @ts-expect-error recursive string paths are not generated criteria.
sessions.where({ "windows.some.name": "editor" });
// @ts-expect-error model methods never become criteria fields.
sessions.where({ equals: true });
// @ts-expect-error legacy syntax never enters canonical criteria.
sessions.where({ name__contains: "main" });
// Relations are camelCase; the tmux wire spellings belong to the document.
sessions.where({ activeWindow: { is: null } });
windows.where({ linkedSessions: { some: {} } });
// @ts-expect-error wire spellings are not accepted as criteria.
sessions.where({ active_window: { is: null } });
// @ts-expect-error wire spellings are not accepted as criteria.
windows.where({ linked_sessions: { some: {} } });
// @ts-expect-error deprecated children is absent.
sessions.where({ children: { some: {} } });
// @ts-expect-error Session criteria cannot be passed to a Window Selection.
windows.where({ windows: { some: {} } });
// @ts-expect-error whole wire documents are not criteria.
sessions.where(sessionDocument);
// @ts-expect-error Pane is not a legacy adapter model.
parseLegacyWhere("pane", { name__contains: "x" });
// @ts-expect-error Client is not a legacy adapter model.
parseLegacyWhere("client", { name__contains: "x" });

void sessionCriteria;
void windowCriteria;
void paneCriteria;
void sessionDocument;
void windowDocument;
