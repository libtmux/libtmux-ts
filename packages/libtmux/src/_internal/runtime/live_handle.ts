import type { FormatFieldName } from "../../_generated/format_field_names.js";
import type { Client } from "../../client.js";
import type { LogicalRef } from "../../common.js";
import { LibTmuxException } from "../../exc.js";
import type { Pane } from "../../pane.js";
import type { Server } from "../../server.js";
import type { Session } from "../../session.js";
import type { Window } from "../../window.js";
import { FORMAT_FIELD_TOKENS } from "../../_generated/format_fields.js";
import { decodeFormatValue } from "../codec/format_values.js";
import type { CompleteFormatRow } from "../codec/schemas.js";
import {
  graphRecordRefsEqual,
  isNormalizedGraph,
  type GraphEntityRef,
  type GraphModel,
  type GraphRecordRef,
  type NormalizedGraph,
} from "../graph/model.js";
import type { WinlinkRef } from "../graph/refs.js";
import { runtimeForServer, type RuntimeContext } from "./context.js";

type Child = Client | Pane | Session | Window;
type LogicalHandle = Pane | Session | Window;

export interface LiveHandleInitialization {
  readonly entity: GraphEntityRef;
  readonly graph: NormalizedGraph;
  readonly model: GraphModel;
  readonly record: GraphRecordRef;
  readonly server: Server;
  readonly snapshot: CompleteFormatRow;
  readonly winlink: WinlinkRef | null;
}

type LiveHandleState = LiveHandleInitialization;

const liveHandleStates = new WeakMap<object, LiveHandleState>();
const installedPrototypes = new WeakSet<object>();

function stateForValue(value: unknown): LiveHandleState | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return liveHandleStates.get(value);
}

function requireState(value: unknown): LiveHandleState {
  const state = stateForValue(value);
  if (state === undefined) throw new LibTmuxException("handle is not authentic");
  return state;
}

function requireAuthenticProvenance(graph: NormalizedGraph, record: GraphRecordRef): void {
  if (
    !isNormalizedGraph(graph) ||
    !graphRecordRefsEqual(record, record) ||
    !graph.records.some((candidate) => graphRecordRefsEqual(candidate.ref, record))
  ) {
    throw new LibTmuxException("handle provenance is not authentic");
  }
}

function freezeState(initialization: LiveHandleInitialization): LiveHandleState {
  return Object.freeze({
    entity: initialization.entity,
    graph: initialization.graph,
    model: initialization.model,
    record: initialization.record,
    server: initialization.server,
    snapshot: initialization.snapshot,
    winlink: initialization.winlink,
  });
}

/**
 * How a handle renders itself in a log line or an error.
 *
 * A handle's own properties are its methods, so the default rendering is a wall
 * of `[Function]` with none of the data that identifies which object this is.
 * Both Node and Bun consult the inspect symbol, and `String()` consults
 * `toString`, so wiring the same description into each covers logging,
 * template literals, and assertion output alike.
 */
function describeHandle(model: GraphModel, snapshot: CompleteFormatRow): string {
  const at = (token: FormatFieldName): string | null => snapshot[token] ?? null;
  if (model === "session") {
    return `Session(${at("session_id") ?? "?"} ${at("session_name") ?? "?"})`;
  }
  if (model === "window") {
    const where = `${at("window_index") ?? "?"}:${at("window_name") ?? "?"}`;
    return `Window(${at("window_id") ?? "?"} ${where}, Session(${at("session_id") ?? "?"} ${at("session_name") ?? "?"}))`;
  }
  if (model === "pane") {
    const where = `${at("window_index") ?? "?"}:${at("window_name") ?? "?"}`;
    return `Pane(${at("pane_id") ?? "?"} Window(${at("window_id") ?? "?"} ${where}, Session(${at("session_id") ?? "?"} ${at("session_name") ?? "?"})))`;
  }
  return `Client(${at("client_tty") ?? "?"})`;
}

// Node and Bun both honour this well-known key when rendering a value.
const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

export function installLiveHandlePrototype(
  prototype: object,
  aliases: Readonly<Record<string, FormatFieldName>> = {},
): void {
  if (installedPrototypes.has(prototype)) return;

  Object.defineProperty(prototype, "server", {
    configurable: false,
    enumerable: false,
    get(this: object): Server {
      return requireState(this).server;
    },
  });
  Object.defineProperty(prototype, "format", {
    configurable: false,
    enumerable: false,
    get(this: object): CompleteFormatRow {
      return requireState(this).snapshot;
    },
  });
  for (const [alias, token] of Object.entries(aliases)) {
    Object.defineProperty(prototype, alias, {
      configurable: false,
      enumerable: false,
      get(this: object): boolean | number | string | Date | null {
        return decodeFormatValue(token, requireState(this).snapshot[token]);
      },
    });
  }
  const description = function (this: object): string {
    const state = requireState(this);
    return describeHandle(state.model, state.snapshot);
  };
  for (const key of ["toString", inspectSymbol] as const) {
    Object.defineProperty(prototype, key, {
      configurable: false,
      enumerable: false,
      value: description,
      writable: false,
    });
  }
  installedPrototypes.add(prototype);
}

export function initializeLiveHandle<Handle extends Child>(
  handle: Handle,
  initialization: LiveHandleInitialization,
): Handle {
  if (liveHandleStates.has(handle)) {
    throw new LibTmuxException("handle is already initialized");
  }
  if (initialization.entity.kind !== initialization.model) {
    throw new LibTmuxException("handle model does not match its entity");
  }
  requireAuthenticProvenance(initialization.graph, initialization.record);
  const state = freezeState(initialization);
  liveHandleStates.set(handle, state);
  Object.freeze(handle);
  return handle;
}

/**
 * Whether two handles describe the same thing on the same tmux server.
 *
 * A tmux id is unique only within one daemon, so `%1` alone answers a question
 * nobody asked: every server has one. The server the handle was resolved
 * against is what makes the answer mean "the same pane" — and it is the server
 * rather than the runtime, because two `new Server({ socketPath })` for one
 * socket are two objects addressing one daemon, whose handles genuinely do name
 * the same panes. The connection alias is per-object and would say otherwise.
 *
 * This deliberately cannot see a daemon restart: tmux reissues ids from the
 * start, and nothing in a handle's own row distinguishes the new `%1` from the
 * old one. That is what `Server.daemonIdentity` is for, and why a mutation
 * checks it rather than trusting equality to have caught it.
 *
 * {@link liveHandlesShareTmuxId} is the raw-id comparison, for callers who
 * genuinely want it.
 */
export function liveHandlesEqual(left: Child, other: unknown): boolean {
  const leftState = stateForValue(left);
  const rightState = stateForValue(other);
  if (leftState === undefined || rightState === undefined || leftState.model !== rightState.model) {
    return false;
  }
  if (!leftState.server.equals(rightState.server)) return false;
  if (leftState.model !== "client") {
    return (
      leftState.entity.kind === rightState.entity.kind &&
      leftState.entity.id === rightState.entity.id
    );
  }
  // tmux gives a client no id of its own, so the row is the identity. Two
  // readings of one client at different instants are different clients here,
  // which is why Client has no `sameTmuxIdAs`.
  for (const token of FORMAT_FIELD_TOKENS) {
    if (leftState.snapshot[token] !== rightState.snapshot[token]) return false;
  }
  return true;
}

/**
 * Whether two handles carry the same tmux id, wherever they came from.
 *
 * This is the comparison {@link liveHandlesEqual} deliberately is not: it says
 * two ids match, not that they name the same object.
 */
export function liveHandlesShareTmuxId(left: Child, other: unknown): boolean {
  const leftState = stateForValue(left);
  const rightState = stateForValue(other);
  if (leftState === undefined || rightState === undefined) return false;
  return leftState.model === rightState.model && leftState.entity.id === rightState.entity.id;
}

/**
 * The runtime a handle may command, refusing one the daemon has outlived.
 *
 * Reading a handle's fields and relations is always fine: they describe the
 * instant it was captured at, and answering from a frozen graph reaches no
 * server. Sending a command is different — it carries a raw `%n`, and tmux
 * numbers a restarted daemon's panes from the start, so an id from the previous
 * daemon now names somebody else's pane. Acquisition notices the restart and
 * moves the epoch on; this is where that turns into a refusal instead of a
 * `kill-pane` against the wrong pane.
 */
export function runtimeForHandle(handle: Child): RuntimeContext {
  const state = requireState(handle);
  const runtime = runtimeForServer(state.server);
  if (state.graph.capture.epoch !== runtime.daemonEpoch) {
    throw new LibTmuxException(
      `${describeHandle(state.model, state.snapshot)} came from a tmux server that has since restarted`,
    );
  }
  return runtime;
}

export function entityRefForHandle(handle: Child): GraphEntityRef {
  return requireState(handle).entity;
}

export function originGraphForHandle(handle: Child): NormalizedGraph {
  return requireState(handle).graph;
}

export function graphRecordRefForHandle(handle: Child): GraphRecordRef {
  return requireState(handle).record;
}

export function logicalRefForHandle(handle: LogicalHandle): LogicalRef {
  const entity = requireState(handle).entity;
  if (entity.kind === "client") throw new LibTmuxException("Client has no logical reference");
  return entity;
}

export function snapshotForHandle(handle: Child): CompleteFormatRow {
  return requireState(handle).snapshot;
}

export function winlinkRefForHandle(handle: Child): WinlinkRef | null {
  return requireState(handle).winlink;
}
