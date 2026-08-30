import { Client } from "../../src/client.js";
import type { PaneId, WindowId } from "../../src/common.js";
import type { SelectionProjection } from "../../src/_internal/graph/projection_identity.js";
import type { ModelForKind } from "../../src/_internal/runtime/model_kind.js";
import { createProjectedSelection } from "../../src/_internal/selection/evaluate.js";
import { Pane } from "../../src/pane.js";
import { Server } from "../../src/server.js";
import { Session } from "../../src/session.js";
import { Window } from "../../src/window.js";
import * as selectionModule from "../../src/selection.js";
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
import type { CompleteFormatRow } from "../../src/_internal/codec/schemas.js";
import type { Equal, Expect } from "./assert.js";

// The query surface is reachable from the package root, and is the same type
// the dedicated subpath exports.
type _RootSelection = Expect<
  Equal<import("../../src/index.js").Selection<Session>, Selection<Session>>
>;
type _RootWhereOf = Expect<Equal<import("../../src/index.js").WhereOf<Session>, WhereOf<Session>>>;
type _RootSessionWhere = Expect<Equal<import("../../src/index.js").SessionWhere, SessionWhere>>;
type _RootWindowWhere = Expect<Equal<import("../../src/index.js").WindowWhere, WindowWhere>>;
type _RootPaneWhere = Expect<Equal<import("../../src/index.js").PaneWhere, PaneWhere>>;
type _RootRegexCriteriaData = Expect<
  Equal<import("../../src/index.js").RegexCriteriaData, RegexCriteriaData>
>;
type _RootWhereDocumentV1 = Expect<
  Equal<import("../../src/index.js").WhereDocumentV1, WhereDocumentV1>
>;

type ExpectedSelection<Model> = {
  readonly length: number;
  [Symbol.iterator](): IterableIterator<Model>;
  at(index: number): Model | undefined;
  toArray(): Model[];
  map<Result>(
    transform: (value: Model, index: number, values: readonly Model[]) => Result,
    thisArg?: unknown,
  ): Result[];
  filter<Narrowed extends Model>(
    predicate: (value: Model, index: number, values: readonly Model[]) => value is Narrowed,
    thisArg?: unknown,
  ): Selection<Narrowed>;
  filter(
    predicate: (value: Model, index: number, values: readonly Model[]) => unknown,
    thisArg?: unknown,
  ): Selection<Model>;
  where(criteria: WhereOf<Model>): Selection<Model>;
  first(criteria?: WhereOf<Model>): Model | undefined;
  one(criteria?: WhereOf<Model>): Model;
  oneOrUndefined(criteria?: WhereOf<Model>): Model | undefined;
  exists(criteria?: WhereOf<Model>): boolean;
  count(criteria?: WhereOf<Model>): number;
};

type StructuralSession = CompleteFormatRow & {
  readonly equals: (other: unknown) => boolean;
  readonly server: Server;
};

type ExpectedParseLegacyWhere = <Model extends "session" | "window">(
  model: Model,
  input: unknown,
) => Extract<WhereDocumentV1, { readonly model: Model }>;
type ExpectedCreateProjectedSelection = <Kind extends "client" | "pane" | "session" | "window">(
  model: Kind,
  values: readonly ModelForKind<Kind>[],
  projection: SelectionProjection,
) => Selection<ModelForKind<Kind>>;

type _SelectionShape = Expect<Equal<Selection<Session>, ExpectedSelection<Session>>>;
type _SelectionKeys = Expect<
  Equal<
    keyof Selection<Session>,
    | typeof Symbol.iterator
    | "at"
    | "count"
    | "exists"
    | "filter"
    | "first"
    | "length"
    | "map"
    | "one"
    | "oneOrUndefined"
    | "toArray"
    | "where"
  >
>;
type _SessionWhere = Expect<Equal<WhereOf<Session>, SessionWhere>>;
type _WindowWhere = Expect<Equal<WhereOf<Window>, WindowWhere>>;
type _PaneWhere = Expect<Equal<WhereOf<Pane>, PaneWhere>>;
type _ClientWhere = Expect<Equal<WhereOf<Client>, ClientWhere>>;
type _ServerWhere = Expect<Equal<WhereOf<Server>, never>>;
type _UnknownWhere = Expect<Equal<WhereOf<unknown>, never>>;
type _StructuralWhere = Expect<Equal<WhereOf<StructuralSession>, never>>;
type _ParseLegacyWhere = Expect<Equal<typeof parseLegacyWhere, ExpectedParseLegacyWhere>>;
type _CreateProjectedSelection = Expect<
  Equal<typeof createProjectedSelection, ExpectedCreateProjectedSelection>
>;
type _RuntimeExports = Expect<
  Equal<
    keyof typeof selectionModule,
    "decodeWhereDocument" | "encodeWhereDocument" | "parseLegacyWhere"
  >
>;
type _RegexData = Expect<
  Equal<RegexCriteriaData, { readonly flags: "" | "m" | "s" | "ms"; readonly pattern: string }>
>;

declare const clients: Selection<Client>;
declare const panes: Selection<Pane>;
declare const sessions: Selection<Session>;
declare const windows: Selection<Window>;
declare const mixed: Selection<Session | Window>;
declare const session: Session;
declare const dynamicPaneId: string;
declare const paneId: PaneId;
declare const windowId: WindowId;

void sessions.length;
void sessions.at(-1);
void sessions.toArray();
void sessions.where({ name: "main" });
void sessions.first();
void sessions.first({ name: "main" });
void sessions.one();
void sessions.one({ name: "main" });
void sessions.oneOrUndefined();
void sessions.exists();
void sessions.count();
void panes.where({ id: "%1" });
void panes.where({ id: dynamicPaneId });
void panes.where({ id: paneId });
// @ts-expect-error A branded window id cannot cross into a pane criterion.
void panes.where({ id: windowId });
// @ts-expect-error Equality preserves the id brand.
void panes.where({ id: { equals: windowId } });
// @ts-expect-error Membership preserves the id brand.
void panes.where({ id: { in: [windowId] } });
void windows.where({ name: "editor" });
void clients.first();
void clients.one();
void clients.oneOrUndefined();
void clients.exists();
void clients.count();

const callbackFiltered = sessions.filter(
  (value: Session, index: number, values: readonly Session[]) => {
    void value.id;
    void index;
    void values[0]?.name;
    // @ts-expect-error callback values are readonly.
    values[0] = session;
    return true;
  },
);
type _CallbackResult = Expect<Equal<typeof callbackFiltered, Selection<Session>>>;

const narrowed = mixed.filter(
  (value: Session | Window): value is Session => value instanceof Session,
);
type _TypeGuardNarrowing = Expect<Equal<typeof narrowed, Selection<Session>>>;

const thisArgument = { prefix: "m" };
sessions.filter(function (this: typeof thisArgument, value: Session) {
  return value.name?.startsWith(this.prefix);
}, thisArgument);

// @ts-expect-error Selection is a type-only interface, not a constructor value.
void new Selection<Session>();
// @ts-expect-error Selection accepts exactly one type parameter.
type InvalidSelection = Selection<Session, SessionWhere>;
// @ts-expect-error callback filtering requires a predicate.
sessions.filter();
// @ts-expect-error callback filtering does not accept declarative criteria.
sessions.filter({ name: "main" });
// @ts-expect-error where requires declarative data.
sessions.where((value: Session) => value.name === "main");
// @ts-expect-error Session criteria do not accept Window fields.
sessions.where({ window_id: "@1" });
// A client is queryable like any other model, by its own fields.
const controlClients = clients.where({ controlMode: "1" });
clients.first({ tty: "" });
// @ts-expect-error Client criteria do not accept another model's fields.
clients.where({ paneId: "%1" });
// @ts-expect-error Selection has no exactly-one get alias.
sessions.get({ name: "main" });
// @ts-expect-error Selection has no Array mutation surface.
sessions.push(session);
// @ts-expect-error Selection has no direct index signature.
void sessions[0];
// @ts-expect-error QueryList is intentionally absent.
type MissingQueryList = import("../../src/selection.js").QueryList<Session>;
type PresentClientWhere = import("../../src/selection.js").ClientWhere;
// @ts-expect-error scalar helper types remain private implementation details.
type MissingStringFilter = import("../../src/selection.js").StringFilter;

void callbackFiltered;
void controlClients;
void narrowed;
void (null as unknown as InvalidSelection);
void (null as unknown as MissingQueryList);
void (null as unknown as PresentClientWhere);
void (null as unknown as MissingStringFilter);
