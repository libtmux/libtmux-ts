import { describe, expect, test } from "bun:test";

import { FORMAT_FIELD_TOKENS } from "../../src/_generated/format_fields.js";
import type {
  ConnectionAlias,
  DaemonEpoch,
  LogicalRef,
  TmuxLogger,
  TmuxWarningSink,
} from "../../src/common.js";
import { safeInteger } from "../../src/common.js";
import { LibTmuxException, QueryValidationError } from "../../src/exc.js";
import {
  CLIENT_ALIASES,
  PANE_ALIASES,
  SESSION_ALIASES,
  WINDOW_ALIASES,
} from "../../src/_generated/field_aliases.js";
import { Client } from "../../src/client.js";
import type { RawCompleteFormatRow } from "../../src/_internal/codec/schemas.js";
import {
  createGraphRecordRef,
  createGraphSourceId,
  type CapturedRowSet,
  type GraphRecord,
  type GraphRecordRef,
  type NormalizedGraph,
} from "../../src/_internal/graph/model.js";
import { normalizeGraph } from "../../src/_internal/graph/normalize.js";
import {
  SelectionProjectionBuilder,
  type ProjectionDescriptor,
  type ProjectionRecord,
  type SelectionProjection,
} from "../../src/_internal/graph/selection_projection.js";
import {
  materializeClientRecord,
  materializeProjectionMembers,
  materializeProjectionRecord,
} from "../../src/_internal/graph/materialize.js";
import { decodeLogicalRef } from "../../src/_internal/graph/refs.js";
import {
  bindLogicalRef,
  createRuntimeContext,
  createServerWithRuntime,
  invalidateRuntimeEpoch,
  runtimeForServer,
  type RuntimeContext,
} from "../../src/_internal/runtime/context.js";
import { deriveTmuxCapabilities } from "../../src/_internal/runtime/capabilities.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import {
  entityRefForHandle,
  logicalRefForHandle,
  snapshotForHandle,
  winlinkRefForHandle,
} from "../../src/_internal/runtime/live_handle.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";
import { flattenInvocation } from "../../src/_internal/transport/invocation.js";
import { WHERE_FIELDS_V1, type WhereModel } from "../../src/_generated/where_fields.js";
import { Pane } from "../../src/pane.js";
import { Server, type ServerOptions } from "../../src/server.js";
import { Session } from "../../src/session.js";
import type { ListCommand } from "../../src/_internal/codec/format_types.js";
import { Window } from "../../src/window.js";
import { completeFormatRow, type MutableCompleteFormatRow } from "../support/graph_rows.js";

const encoder = new TextEncoder();

interface RecordingTransport extends CommandTransport {
  readonly requests: CommandRequest[];
}

interface RuntimeFixture {
  readonly runtime: RuntimeContext;
  readonly server: Server;
  readonly transport: RecordingTransport;
}

function alias(value: string): ConnectionAlias {
  return value as ConnectionAlias;
}

function epoch(value: number): DaemonEpoch {
  return value as DaemonEpoch;
}

function resultFor(request: CommandRequest, version = "3.7b"): RawCommandResult {
  return {
    cmd: Object.freeze([request.executable, ...flattenInvocation(request)]),
    returncode: 0,
    signal: null,
    stderr: new Uint8Array(),
    stdout: encoder.encode(`${version}\n`),
  };
}

function recordingTransport(onExecute?: () => void): RecordingTransport {
  const requests: CommandRequest[] = [];
  return {
    requests,
    async execute(request) {
      requests.push(request);
      onExecute?.();
      return resultFor(request);
    },
  };
}

function runtimeFixture(
  options: {
    readonly alias?: string;
    readonly epoch?: number;
    readonly logger?: TmuxLogger;
    readonly onExecute?: () => void;
    readonly connection?: ServerOptions;
    readonly warnings?: TmuxWarningSink;
  } = {},
): RuntimeFixture {
  const transport = recordingTransport(options.onExecute);
  const connectionOptions = options.connection ?? { socketName: "handles" };
  const runtime = createRuntimeContext({
    connection: new TmuxConnection({
      executable: connectionOptions.tmuxBin ?? "tmux",
      ...(connectionOptions.colors === undefined ? {} : { colors: connectionOptions.colors }),
      ...(connectionOptions.configFile === undefined
        ? {}
        : { configFile: connectionOptions.configFile }),
      ...(connectionOptions.environment === undefined
        ? {}
        : { environment: connectionOptions.environment }),
      ...(connectionOptions.socketName === undefined
        ? {}
        : { socketName: connectionOptions.socketName }),
      ...(connectionOptions.socketPath === undefined
        ? {}
        : { socketPath: connectionOptions.socketPath }),
    }),
    connectionAlias: alias(options.alias ?? "handles-runtime"),
    daemonEpoch: epoch(options.epoch ?? 0),
    transport,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.warnings === undefined ? {} : { warnings: options.warnings }),
  });
  return {
    runtime,
    server: createServerWithRuntime(runtime),
    transport,
  };
}

function source(
  id: string,
  listCommand: ListCommand,
  rows: readonly MutableCompleteFormatRow[],
): CapturedRowSet {
  return { listCommand, rows, source: createGraphSourceId(id) };
}

async function graphFor(
  runtime: RuntimeContext,
  sources: readonly CapturedRowSet[],
  fingerprint?: string,
): Promise<NormalizedGraph> {
  const capabilities = await runtime.capabilities.bind();
  return normalizeGraph({
    capture: {
      capabilityFingerprint: fingerprint ?? capabilities.fingerprint,
      connection: runtime.connectionAlias,
      epoch: runtime.daemonEpoch,
    },
    sources,
  });
}

function descriptors(): Readonly<Record<WhereModel, ProjectionDescriptor>> {
  return {
    client: { fields: WHERE_FIELDS_V1.client, model: "client", relations: [] },
    pane: { fields: WHERE_FIELDS_V1.pane, model: "pane", relations: [] },
    session: { fields: WHERE_FIELDS_V1.session, model: "session", relations: [] },
    window: { fields: WHERE_FIELDS_V1.window, model: "window", relations: [] },
  };
}

function projectionFor(graph: NormalizedGraph, sourceId: string): SelectionProjection {
  return SelectionProjectionBuilder.create({
    descriptors: descriptors(),
    graph,
    source: createGraphSourceId(sourceId),
  }).seal();
}

function projectionRecord(projection: SelectionProjection, index = 0): ProjectionRecord {
  const record = projection.records[index];
  if (record === undefined) throw new Error(`missing projection record ${String(index)}`);
  return record;
}

function graphRecordRef(graph: NormalizedGraph, sourceId: string, index = 0): GraphRecordRef {
  const ref = graph.sources.find(({ id }) => id === sourceId)?.records[index];
  if (ref === undefined) throw new Error(`missing graph record ${sourceId}:${String(index)}`);
  return ref;
}

function graphRecord(graph: NormalizedGraph, sourceId: string, index = 0): GraphRecord {
  const ref = graphRecordRef(graph, sourceId, index);
  const record = graph.records.find((candidate) => candidate.ref === ref);
  if (record === undefined)
    throw new Error(`missing normalized record ${sourceId}:${String(index)}`);
  return record;
}

function logicalEntityForRecord(record: GraphRecord): LogicalRef {
  if (record.entity.kind === "client") throw new Error("expected a logical graph entity");
  return record.entity;
}

function descriptorFor(value: object, property: PropertyKey): PropertyDescriptor | undefined {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor !== undefined) return descriptor;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function assertScalarSnapshot(
  handle: Session | Window | Pane | Client,
  row: RawCompleteFormatRow,
): void {
  const snapshot = snapshotForHandle(handle);
  expect(Object.isFrozen(handle)).toBe(true);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Reflect.ownKeys(snapshot)).toEqual([...FORMAT_FIELD_TOKENS]);
  expect(Reflect.ownKeys(handle)).toEqual([]);
  expect(Object.keys(handle)).toEqual([]);
  const serverDescriptor = descriptorFor(handle, "server");
  expect(serverDescriptor?.enumerable).toBe(false);
  expect(typeof serverDescriptor?.get).toBe("function");
  expect(
    serverDescriptor !== undefined &&
      "set" in serverDescriptor &&
      serverDescriptor.set === undefined,
  ).toBe(true);

  // Raw tokens are reachable through the frozen row, not as handle properties.
  for (const token of FORMAT_FIELD_TOKENS) {
    expect(handle.format[token]).toBe(row[token]);
  }
  const formatDescriptor = descriptorFor(handle, "format");
  expect(formatDescriptor?.enumerable).toBe(false);
  expect(typeof formatDescriptor?.get).toBe("function");
  expect(
    formatDescriptor !== undefined &&
      "set" in formatDescriptor &&
      formatDescriptor.set === undefined,
  ).toBe(true);
  expect(Reflect.set(handle, "format", "forbidden")).toBe(false);

  for (const value of Object.values(snapshot)) {
    expect(value === null || typeof value === "string").toBe(true);
  }
  expect(JSON.stringify(handle)).toBe("{}");
}

function assertChildPrototypeAccessors(prototype: object, aliases: readonly string[]): void {
  // Every raw token lives behind `format`, so the prototype carries the
  // idiomatic names and nothing else.
  for (const token of FORMAT_FIELD_TOKENS) {
    if (aliases.includes(token)) continue;
    expect(Object.getOwnPropertyDescriptor(prototype, token), token).toBeUndefined();
  }
  for (const property of ["server", "format", ...aliases]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    expect(descriptor, property).toBeDefined();
    expect(descriptor?.enumerable, property).toBe(false);
    expect(typeof descriptor?.get, property).toBe("function");
    expect(descriptor !== undefined && "set" in descriptor && descriptor.set === undefined).toBe(
      true,
    );
  }
}

function assertConcreteHandlePrototype(
  handle: Session | Window | Pane | Client,
  prototype: object,
  aliases: readonly string[],
): void {
  expect(Object.getPrototypeOf(handle)).toBe(prototype);
  assertChildPrototypeAccessors(prototype, aliases);
}

function assertRejectsNonAuthenticEquality(
  handle: Session | Window | Pane | Client,
  prototype: object,
): void {
  expect(handle.equals(Object.create(prototype))).toBe(false);
  for (const value of [
    null,
    undefined,
    false,
    true,
    0,
    1,
    1n,
    "",
    "lookalike",
    Symbol("lookalike"),
  ]) {
    expect(handle.equals(value)).toBe(false);
  }

  let trapCalls = 0;
  const traps: ProxyHandler<object> = {
    get() {
      trapCalls += 1;
      throw new Error("authentic proxy getter must not run");
    },
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("authentic proxy prototype trap must not run");
    },
  };
  const liveProxy = new Proxy(handle, traps);
  const revoked = Proxy.revocable(handle, traps);
  revoked.revoke();

  expect(handle.equals(liveProxy)).toBe(false);
  expect(handle.equals(revoked.proxy)).toBe(false);
  expect(trapCalls).toBe(0);
}

function validChangedValue(token: (typeof FORMAT_FIELD_TOKENS)[number]): string {
  switch (token) {
    case "client_name":
      return "client-other";
    case "pane_id":
      return "%2";
    case "next_session_id":
    case "session_id":
      return "$2";
    case "window_id":
      return "@2";
    case "window_index":
      return "2";
    default:
      return `different-${token}`;
  }
}

describe("server and runtime foundations", () => {
  test("constructs an immutable default runtime without tmux I/O", () => {
    const environment = { LC_ALL: "C.UTF-8", TERM: "tmux-256color" };
    const options = {
      colors: 256 as const,
      configFile: "/tmp/handles.conf",
      environment,
      socketName: "named",
      tmuxBin: "missing-tmux-must-not-run",
    };

    const server = new Server(options);
    const runtime = runtimeForServer(server);
    environment.TERM = "changed";
    options.configFile = "/tmp/changed.conf";

    expect(server).toMatchObject({
      colors: 256,
      configFile: "/tmp/handles.conf",
      socketName: "named",
      socketPath: undefined,
      tmuxBin: "missing-tmux-must-not-run",
    });
    expect(runtime.connection.environment).toEqual({
      LC_ALL: "C.UTF-8",
      TERM: "tmux-256color",
    });
    expect(runtime.daemonEpoch).toBe(epoch(0));
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.connection)).toBe(true);
  });

  test("defaults the executable and rejects conflicting socket selectors", () => {
    const server = new Server();
    const defaultEnvironment = runtimeForServer(server).connection.environment;

    expect(server.tmuxBin).toBe("tmux");
    expect(Object.isFrozen(defaultEnvironment)).toBe(true);
    expect("PATH" in defaultEnvironment).toBe(true);
    expect(defaultEnvironment.PATH).toBe(process.env.PATH);
    expect(Object.keys(defaultEnvironment).length).toBeGreaterThan(0);
    expect(
      Object.entries(defaultEnvironment).every(
        ([key, value]) => key.length > 0 && (value === undefined || typeof value === "string"),
      ),
    ).toBe(true);
    expect(() => new Server({ socketName: "named", socketPath: "/tmp/handles.sock" })).toThrow(
      "socketName and socketPath are mutually exclusive",
    );
  });

  test("installs usable no-op observability defaults without public options", () => {
    const server = new Server();
    const runtime = runtimeForServer(server);

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(() => {
      runtime.logger.debug("debug");
      runtime.logger.error("error");
      runtime.logger.info("info");
      runtime.logger.warn("warn");
      runtime.warnings.warn({ code: "test-warning", message: "test warning" });
    }).not.toThrow();
    expect("logger" in server).toBe(false);
    expect("warnings" in server).toBe(false);
  });

  test("retains injected observability resources without snapshot leakage", async () => {
    const loggerCalls: string[] = [];
    const warningCodes: string[] = [];
    const logger: TmuxLogger = {
      debug(message) {
        loggerCalls.push(`debug:${message}`);
      },
      error(message) {
        loggerCalls.push(`error:${message}`);
      },
      info(message) {
        loggerCalls.push(`info:${message}`);
      },
      warn(message) {
        loggerCalls.push(`warn:${message}`);
      },
    };
    const warnings: TmuxWarningSink = {
      warn(warning) {
        warningCodes.push(warning.code);
      },
    };
    const fixture = runtimeFixture({ logger, warnings });

    expect(Object.isFrozen(fixture.runtime)).toBe(true);
    expect(fixture.runtime.logger).toBe(logger);
    expect(fixture.runtime.warnings).toBe(warnings);
    fixture.runtime.logger.info("retained");
    fixture.runtime.warnings.warn({ code: "retained", message: "retained" });
    expect(loggerCalls).toEqual(["info:retained"]);
    expect(warningCodes).toEqual(["retained"]);

    const graph = await graphFor(fixture.runtime, [
      source("sessions", "list-sessions", [
        completeFormatRow({ session_id: "$1", session_name: "observed" }),
      ]),
    ]);
    const projection = projectionFor(graph, "sessions");
    const handle = await materializeProjectionRecord(
      fixture.server,
      projection,
      graph,
      projectionRecord(projection),
    );
    const snapshot = snapshotForHandle(handle);

    expect(Reflect.ownKeys(snapshot)).toEqual([...FORMAT_FIELD_TOKENS]);
    expect("logger" in snapshot).toBe(false);
    expect("warnings" in snapshot).toBe(false);
    expect("logger" in handle).toBe(false);
    expect("warnings" in handle).toBe(false);
  });

  test("derives an internal Server and binds the exact runtime object", () => {
    const fixture = runtimeFixture({
      connection: {
        colors: 88,
        configFile: "/tmp/runtime-only.conf",
        environment: { FIXTURE_ENV: "runtime-only" },
        socketPath: "/tmp/runtime-only.sock",
        tmuxBin: "runtime-tmux",
      },
    });

    const boundRuntime = runtimeForServer(fixture.server);
    expect(boundRuntime).toBe(fixture.runtime);
    expect(fixture.server).toMatchObject({
      colors: 88,
      configFile: "/tmp/runtime-only.conf",
      socketName: undefined,
      socketPath: "/tmp/runtime-only.sock",
      tmuxBin: "runtime-tmux",
    });
    expect(fixture.server.colors).toBe(fixture.runtime.connection.colors);
    expect(fixture.server.configFile).toBe(fixture.runtime.connection.configFile);
    expect(fixture.server.socketName).toBe(fixture.runtime.connection.socketName);
    expect(fixture.server.socketPath).toBe(fixture.runtime.connection.socketPath);
    expect(fixture.server.tmuxBin).toBe(fixture.runtime.connection.executable);
    expect(invalidateRuntimeEpoch(fixture.runtime)).toBe(epoch(1));
    expect(boundRuntime.daemonEpoch).toBe(epoch(1));
    expect(runtimeForServer(fixture.server)).toBe(boundRuntime);
  });

  test("assigns opaque aliases independently from connection selectors", () => {
    const first = new Server({ socketPath: "/tmp/private-first.sock" });
    const second = new Server({ socketPath: "/tmp/private-first.sock" });
    const firstAlias = runtimeForServer(first).connectionAlias;
    const secondAlias = runtimeForServer(second).connectionAlias;

    expect(firstAlias).not.toBe(secondAlias);
    expect(firstAlias).not.toContain("private-first");
    expect(secondAlias).not.toContain("private-first");
    expect(String(firstAlias).length).toBeGreaterThan(0);
    expect(String(secondAlias).length).toBeGreaterThan(0);
  });

  test("invalidates the private epoch cell without replacing the context", () => {
    const fixture = runtimeFixture({ epoch: 4 });
    const original = fixture.runtime;
    const originalAlias = fixture.runtime.connectionAlias;

    expect(invalidateRuntimeEpoch(fixture.runtime)).toBe(epoch(5));
    expect(fixture.runtime).toBe(original);
    expect(fixture.runtime.connectionAlias).toBe(originalAlias);
    expect(fixture.runtime.daemonEpoch).toBe(epoch(5));
    expect(Object.isFrozen(fixture.runtime)).toBe(true);
  });

  test("wires capability identity through the runtime context", async () => {
    const fixture = runtimeFixture({ alias: "capability-wiring", epoch: 6 });

    const capabilities = await fixture.runtime.capabilities.bind();
    const expected = deriveTmuxCapabilities({
      connectionAlias: fixture.runtime.connectionAlias,
      daemonEpoch: fixture.runtime.daemonEpoch,
      rawVersion: "3.7b",
    });

    expect(capabilities.connectionAlias).toBe(fixture.runtime.connectionAlias);
    expect(capabilities.daemonEpoch).toBe(fixture.runtime.daemonEpoch);
    expect(capabilities.fingerprint).toBe(expected.fingerprint);
    expect(fixture.transport.requests).toHaveLength(1);

    expect(invalidateRuntimeEpoch(fixture.runtime)).toBe(epoch(7));
    const rebound = await fixture.runtime.capabilities.bind();

    expect(rebound.daemonEpoch).toBe(epoch(7));
    expect(rebound.fingerprint).not.toBe(capabilities.fingerprint);
    expect(fixture.transport.requests).toHaveLength(2);
  });

  test("retains the injected connection and transport by identity", () => {
    const connection = new TmuxConnection({ executable: "tmux", socketName: "identity" });
    const transport = recordingTransport();

    const runtime = createRuntimeContext({
      connection,
      connectionAlias: alias("identity"),
      daemonEpoch: epoch(0),
      transport,
    });

    expect(runtime.connection).toBe(connection);
    expect(runtime.transport).toBe(transport);
  });
});

describe("logical reference binding", () => {
  test("canonicalizes only the four serialized keys", async () => {
    const fixture = runtimeFixture({ alias: "bound-runtime", epoch: 7 });
    const input = { connection: "bound-runtime", epoch: 7, id: "$1", kind: "session" };

    const bound = await bindLogicalRef(fixture.runtime, input);

    expect([String(bound.connection), Number(bound.epoch), bound.kind, String(bound.id)]).toEqual([
      "bound-runtime",
      7,
      "session",
      "$1",
    ]);
    expect(bound).not.toBe(input);
    expect(Reflect.ownKeys(bound)).toEqual(["connection", "epoch", "kind", "id"]);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(fixture.transport.requests).toHaveLength(1);
    expect(flattenInvocation(fixture.transport.requests[0]!)).toEqual([
      "-N",
      "-Lhandles",
      "display-message",
      "-p",
      "#{version}",
    ]);
  });

  test("maps malformed serialized data to invalid-query", async () => {
    const fixture = runtimeFixture();
    const malformed = {
      connection: "handles-runtime",
      epoch: 0,
      executable: "/private/tmux",
      id: "$1",
      kind: "session",
    };

    let observed: unknown;
    try {
      await bindLogicalRef(fixture.runtime, malformed);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(QueryValidationError);
    expect(observed).toMatchObject({ code: "invalid-query" });
    expect(fixture.transport.requests).toHaveLength(0);
  });

  test("rejects wrong aliases and stale epochs before capability binding", async () => {
    const fixture = runtimeFixture({ alias: "current", epoch: 8 });
    const wrongAlias = decodeLogicalRef({
      connection: "other",
      epoch: 8,
      id: "$1",
      kind: "session",
    });
    const staleEpoch = decodeLogicalRef({
      connection: "current",
      epoch: 7,
      id: "$1",
      kind: "session",
    });

    await expect(bindLogicalRef(fixture.runtime, wrongAlias)).rejects.toBeInstanceOf(
      LibTmuxException,
    );
    await expect(bindLogicalRef(fixture.runtime, staleEpoch)).rejects.toBeInstanceOf(
      LibTmuxException,
    );
    expect(fixture.transport.requests).toHaveLength(0);
  });

  test("rejects references from a same-selector server without capability I/O", async () => {
    const left = runtimeFixture({ alias: "same-selector-left" });
    const right = runtimeFixture({ alias: "same-selector-right" });
    const leftRef = decodeLogicalRef({
      connection: "same-selector-left",
      epoch: 0,
      id: "$1",
      kind: "session",
    });

    await expect(bindLogicalRef(right.runtime, leftRef)).rejects.toBeInstanceOf(LibTmuxException);
    expect(left.runtime.connection.socketName).toBe(right.runtime.connection.socketName);
    expect(right.transport.requests).toHaveLength(0);
  });

  test("rejects an epoch invalidated while capability binding is in flight", async () => {
    let runtime: RuntimeContext;
    const transport = recordingTransport(() => {
      invalidateRuntimeEpoch(runtime);
    });
    runtime = createRuntimeContext({
      connection: new TmuxConnection({ executable: "tmux", socketName: "post-bind" }),
      connectionAlias: alias("post-bind"),
      daemonEpoch: epoch(3),
      transport,
    });
    const ref: LogicalRef = decodeLogicalRef({
      connection: "post-bind",
      epoch: 3,
      id: "%1",
      kind: "pane",
    });

    await expect(bindLogicalRef(runtime, ref)).rejects.toBeInstanceOf(LibTmuxException);
    expect(runtime.daemonEpoch).toBe(epoch(4));
    expect(transport.requests).toHaveLength(1);
  });

  test("rejects invalidation after a cached capability bind is selected", async () => {
    const fixture = runtimeFixture({ alias: "cached-post-bind", epoch: 5 });
    await fixture.runtime.capabilities.bind();
    const ref = decodeLogicalRef({
      connection: "cached-post-bind",
      epoch: 5,
      id: "%1",
      kind: "pane",
    });

    const pending = bindLogicalRef(fixture.runtime, ref);
    expect(invalidateRuntimeEpoch(fixture.runtime)).toBe(epoch(6));

    await expect(pending).rejects.toBeInstanceOf(LibTmuxException);
    expect(fixture.transport.requests).toHaveLength(1);
  });
});

describe("authenticated handle materialization", () => {
  test("materializes all four actual child classes from complete graph rows", async () => {
    const fixture = runtimeFixture();
    const rows = {
      client: completeFormatRow({ client_name: "client-one", config_files: "" }),
      pane: completeFormatRow({
        pane_id: "%1",
        pane_title: "pane-one",
        session_id: "$1",
        window_id: "@1",
        window_index: "2",
      }),
      session: completeFormatRow({ session_id: "$1", session_name: "session-one" }),
      window: completeFormatRow({
        session_id: "$1",
        window_id: "@1",
        window_index: "2",
        window_name: "window-one",
      }),
    };
    const graph = await graphFor(fixture.runtime, [
      source("sessions", "list-sessions", [rows.session]),
      source("windows", "list-windows", [rows.window]),
      source("panes", "list-panes", [rows.pane]),
      source("clients", "list-clients", [rows.client]),
    ]);
    const sessionProjection = projectionFor(graph, "sessions");
    const windowProjection = projectionFor(graph, "windows");
    const paneProjection = projectionFor(graph, "panes");
    const records = {
      client: graphRecord(graph, "clients"),
      pane: graphRecord(graph, "panes"),
      session: graphRecord(graph, "sessions"),
      window: graphRecord(graph, "windows"),
    };

    const [session, window, pane, client] = await Promise.all([
      materializeProjectionRecord(
        fixture.server,
        sessionProjection,
        graph,
        projectionRecord(sessionProjection),
      ),
      materializeProjectionRecord(
        fixture.server,
        windowProjection,
        graph,
        projectionRecord(windowProjection),
      ),
      materializeProjectionRecord(
        fixture.server,
        paneProjection,
        graph,
        projectionRecord(paneProjection),
      ),
      materializeClientRecord(fixture.server, graph, graphRecordRef(graph, "clients")),
    ]);

    expect(session).toBeInstanceOf(Session);
    expect(window).toBeInstanceOf(Window);
    expect(pane).toBeInstanceOf(Pane);
    expect(client).toBeInstanceOf(Client);
    expect(session.server).toBe(fixture.server);
    expect(window.server).toBe(fixture.server);
    expect(pane.server).toBe(fixture.server);
    expect(client.server).toBe(fixture.server);
    expect(entityRefForHandle(session as Session)).toBe(records.session.entity);
    expect(entityRefForHandle(window as Window)).toBe(records.window.entity);
    expect(entityRefForHandle(pane as Pane)).toBe(records.pane.entity);
    expect(entityRefForHandle(client)).toBe(records.client.entity);
    expect(logicalRefForHandle(session as Session)).toBe(logicalEntityForRecord(records.session));
    expect(logicalRefForHandle(window as Window)).toBe(logicalEntityForRecord(records.window));
    expect(logicalRefForHandle(pane as Pane)).toBe(logicalEntityForRecord(records.pane));
    expect(records.session.winlink).toBeNull();
    expect(records.client.winlink).toBeNull();
    expect(records.window.winlink).not.toBeNull();
    expect(records.pane.winlink).not.toBeNull();
    expect(winlinkRefForHandle(session as Session)).toBeNull();
    expect(winlinkRefForHandle(client)).toBeNull();
    expect(winlinkRefForHandle(window as Window)).toBe(records.window.winlink);
    expect(winlinkRefForHandle(pane as Pane)).toBe(records.pane.winlink);
    assertConcreteHandlePrototype(
      session as Session,
      Session.prototype,
      Object.keys(SESSION_ALIASES),
    );
    assertConcreteHandlePrototype(window as Window, Window.prototype, Object.keys(WINDOW_ALIASES));
    assertConcreteHandlePrototype(pane as Pane, Pane.prototype, Object.keys(PANE_ALIASES));
    assertConcreteHandlePrototype(client, Client.prototype, Object.keys(CLIENT_ALIASES));
    assertScalarSnapshot(session as Session, rows.session);
    assertScalarSnapshot(window as Window, rows.window);
    assertScalarSnapshot(pane as Pane, rows.pane);
    assertScalarSnapshot(client, rows.client);
    expect(rows.client.config_files).toBe("");
    expect(client.configFiles).toBe("");
    expect(client.format.pane_z).toBeNull();
  });

  test("defines child snapshot accessors on each concrete prototype", () => {
    for (const [Child, aliases] of [
      [Session, SESSION_ALIASES],
      [Window, WINDOW_ALIASES],
      [Pane, PANE_ALIASES],
      [Client, CLIENT_ALIASES],
    ] as const) {
      assertChildPrototypeAccessors(Child.prototype, Object.keys(aliases));
    }
  });

  test("rejects forged and mixed graph, projection, record, and row evidence", async () => {
    const fixture = runtimeFixture();
    const row = completeFormatRow({
      session_id: "$1",
      window_id: "@1",
      window_index: "1",
      window_name: "authentic",
    });
    const graph = await graphFor(fixture.runtime, [source("windows", "list-windows", [row])]);
    const projection = projectionFor(graph, "windows");
    const record = projectionRecord(projection);
    const foreignGraph = await graphFor(fixture.runtime, [
      source("foreign", "list-windows", [completeFormatRow({ ...row })]),
    ]);
    const foreignProjection = projectionFor(foreignGraph, "foreign");
    const forgedRef = createGraphRecordRef(createGraphSourceId("missing"), 0);

    const attempts: Array<() => Promise<unknown>> = [
      () =>
        materializeProjectionRecord(
          fixture.server,
          { ...projection } as SelectionProjection,
          graph,
          record,
        ),
      () =>
        materializeProjectionRecord(
          fixture.server,
          projection,
          { ...graph } as NormalizedGraph,
          record,
        ),
      () =>
        materializeProjectionRecord(fixture.server, projection, graph, {
          ...record,
        } as ProjectionRecord),
      () => materializeProjectionRecord(fixture.server, projection, foreignGraph, record),
      () =>
        materializeProjectionRecord(
          fixture.server,
          projection,
          graph,
          projectionRecord(foreignProjection),
        ),
      () =>
        materializeProjectionRecord(
          fixture.server,
          projection,
          graph,
          row as unknown as ProjectionRecord,
        ),
      () => materializeClientRecord(fixture.server, graph, forgedRef),
      () => materializeClientRecord(fixture.server, graph, row as unknown as GraphRecordRef),
    ];

    for (const attempt of attempts) {
      let observed: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop -- each independent provenance boundary must reject.
        await attempt();
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(QueryValidationError);
    }
  });

  test("rejects authentic non-client records in direct Client materialization", async () => {
    const fixture = runtimeFixture();
    const graph = await graphFor(fixture.runtime, [
      source("sessions", "list-sessions", [
        completeFormatRow({ session_id: "$1", session_name: "not-client" }),
      ]),
      source("windows", "list-windows", [
        completeFormatRow({
          session_id: "$1",
          window_id: "@1",
          window_index: "1",
          window_name: "not-client",
        }),
      ]),
      source("panes", "list-panes", [
        completeFormatRow({
          pane_id: "%1",
          pane_title: "not-client",
          session_id: "$1",
          window_id: "@1",
          window_index: "1",
        }),
      ]),
    ]);

    await Promise.all(
      ["sessions", "windows", "panes"].map(async (sourceId) => {
        await expect(
          materializeClientRecord(fixture.server, graph, graphRecordRef(graph, sourceId)),
        ).rejects.toBeInstanceOf(QueryValidationError);
      }),
    );
  });

  test("resolves reconstructed Client record refs by authenticated value", async () => {
    const fixture = runtimeFixture({ alias: "reconstructed-client-ref" });
    const originalRow = completeFormatRow({ client_name: "client-ref", client_width: "80" });
    const originalGraph = await graphFor(fixture.runtime, [
      source("client-source", "list-clients", [originalRow]),
    ]);
    const originalRef = graphRecordRef(originalGraph, "client-source");
    const reconstructedOriginal = createGraphRecordRef(originalRef.source, originalRef.ordinal);

    expect(reconstructedOriginal).not.toBe(originalRef);
    expect(reconstructedOriginal).toEqual(originalRef);
    const handle = await materializeClientRecord(
      fixture.server,
      originalGraph,
      reconstructedOriginal,
    );
    expect(handle.width).toBe(safeInteger(80));
    expect(handle.format.client_width).toBe("80");

    const replacementRow = completeFormatRow({
      client_name: "client-ref",
      client_width: "132",
    });
    const replacementGraph = await graphFor(fixture.runtime, [
      source("client-replacement", "list-clients", [replacementRow]),
    ]);
    const replacementRef = graphRecordRef(replacementGraph, "client-replacement");
    const reconstructedReplacement = createGraphRecordRef(
      replacementRef.source,
      replacementRef.ordinal,
    );

    expect(reconstructedReplacement).not.toBe(replacementRef);
    expect(reconstructedReplacement).toEqual(replacementRef);
    const later = await materializeClientRecord(
      fixture.server,
      replacementGraph,
      reconstructedReplacement,
    );
    assertScalarSnapshot(later, replacementRow);
    // The earlier reading is untouched: a graph produces handles, and never
    // reaches back into ones another graph already produced.
    assertScalarSnapshot(handle, originalRow);
  });

  test("rejects an authentic projection paired with a different authentic graph", async () => {
    const fixture = runtimeFixture();
    const leftGraph = await graphFor(fixture.runtime, [
      source("windows", "list-windows", [
        completeFormatRow({
          session_id: "$1",
          window_id: "@1",
          window_index: "1",
          window_name: "left-row-must-not-cross",
        }),
      ]),
    ]);
    const rightGraph = await graphFor(fixture.runtime, [
      source("windows", "list-windows", [
        completeFormatRow({
          session_id: "$1",
          window_id: "@1",
          window_index: "1",
          window_name: "right-row-must-not-cross",
        }),
      ]),
    ]);
    const leftProjection = projectionFor(leftGraph, "windows");
    const rightProjection = projectionFor(rightGraph, "windows");

    await expect(
      materializeProjectionRecord(
        fixture.server,
        leftProjection,
        rightGraph,
        projectionRecord(leftProjection),
      ),
    ).rejects.toBeInstanceOf(QueryValidationError);

    const right = await materializeProjectionRecord(
      fixture.server,
      rightProjection,
      rightGraph,
      projectionRecord(rightProjection),
    );
    expect(right.format.window_name).toBe("right-row-must-not-cross");
  });

  test("rejects structural members evidence and an identical authentic twin graph", async () => {
    const fixture = runtimeFixture({ alias: "identical-graph-provenance" });
    const row = completeFormatRow({
      session_id: "$1",
      window_id: "@1",
      window_index: "1",
      window_name: "byte-identical",
    });
    const leftGraph = await graphFor(fixture.runtime, [source("windows", "list-windows", [row])]);
    const rightGraph = await graphFor(fixture.runtime, [
      source("windows", "list-windows", [completeFormatRow({ ...row })]),
    ]);
    const projection = projectionFor(leftGraph, "windows");

    expect(leftGraph).not.toBe(rightGraph);
    expect(leftGraph).toEqual(rightGraph);
    await Promise.all([
      expect(
        materializeProjectionRecord(
          fixture.server,
          projection,
          rightGraph,
          projectionRecord(projection),
        ),
      ).rejects.toBeInstanceOf(QueryValidationError),
      expect(
        materializeProjectionMembers(fixture.server, projection, rightGraph),
      ).rejects.toBeInstanceOf(QueryValidationError),
      expect(
        materializeProjectionMembers(
          fixture.server,
          { ...projection } as SelectionProjection,
          leftGraph,
        ),
      ).rejects.toBeInstanceOf(QueryValidationError),
      expect(
        materializeProjectionMembers(fixture.server, projection, {
          ...leftGraph,
        } as NormalizedGraph),
      ).rejects.toBeInstanceOf(QueryValidationError),
    ]);
  });

  test("rejects a record owned by another authentic projection of the same graph", async () => {
    const fixture = runtimeFixture({ alias: "projection-record-owner" });
    const graph = await graphFor(fixture.runtime, [
      source("sessions", "list-sessions", [
        completeFormatRow({ session_id: "$1", session_name: "same-source" }),
      ]),
    ]);
    const first = projectionFor(graph, "sessions");
    const second = projectionFor(graph, "sessions");
    const firstRecord = projectionRecord(first);
    const secondRecord = projectionRecord(second);

    expect(first).not.toBe(second);
    expect(firstRecord).not.toBe(secondRecord);
    expect(firstRecord).toEqual(secondRecord);
    await expect(
      materializeProjectionRecord(fixture.server, first, graph, secondRecord),
    ).rejects.toBeInstanceOf(QueryValidationError);
  });

  test("rejects capture alias, epoch, and capability mismatches", async () => {
    const fixture = runtimeFixture({ alias: "capture-runtime", epoch: 3 });
    const row = completeFormatRow({ session_id: "$1" });
    const capabilities = await fixture.runtime.capabilities.bind();
    const captures = [
      {
        capabilityFingerprint: capabilities.fingerprint,
        connection: alias("other-runtime"),
        epoch: epoch(3),
      },
      {
        capabilityFingerprint: capabilities.fingerprint,
        connection: alias("capture-runtime"),
        epoch: epoch(2),
      },
      {
        capabilityFingerprint: "other-fingerprint",
        connection: alias("capture-runtime"),
        epoch: epoch(3),
      },
    ];

    for (const capture of captures) {
      const graph = normalizeGraph({
        capture,
        sources: [source("sessions", "list-sessions", [completeFormatRow({ ...row })])],
      });
      const projection = projectionFor(graph, "sessions");
      let observed: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop -- each capture component is an independent stale boundary.
        await materializeProjectionRecord(
          fixture.server,
          projection,
          graph,
          projectionRecord(projection),
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(LibTmuxException);
    }
  });

  test("rejects materialization when a cached capability epoch changes after selection", async () => {
    const fixture = runtimeFixture({ alias: "cached-materialization" });
    const graph = await graphFor(fixture.runtime, [
      source("sessions", "list-sessions", [completeFormatRow({ session_id: "$1" })]),
    ]);
    const projection = projectionFor(graph, "sessions");
    expect(fixture.transport.requests).toHaveLength(1);

    const pending = materializeProjectionRecord(
      fixture.server,
      projection,
      graph,
      projectionRecord(projection),
    );
    expect(invalidateRuntimeEpoch(fixture.runtime)).toBe(epoch(1));

    await expect(pending).rejects.toBeInstanceOf(LibTmuxException);
    expect(fixture.transport.requests).toHaveLength(1);
  });

  test("preserves contextual duplicates and creates fresh handles", async () => {
    const fixture = runtimeFixture();
    const graph = await graphFor(fixture.runtime, [
      source("windows", "list-windows", [
        completeFormatRow({
          session_id: "$1",
          window_id: "@9",
          window_index: "1",
          window_name: "first-context",
        }),
        completeFormatRow({
          session_id: "$2",
          window_id: "@9",
          window_index: "4",
          window_name: "second-context",
        }),
      ]),
    ]);
    const projection = projectionFor(graph, "windows");

    const first = await materializeProjectionMembers(fixture.server, projection, graph);
    const second = await materializeProjectionMembers(fixture.server, projection, graph);

    expect(first).toHaveLength(2);
    expect(first.map(({ format }) => format.window_name)).toEqual([
      "first-context",
      "second-context",
    ]);
    expect(first[0]).not.toBe(first[1]);
    expect(first[0]?.equals(first[1])).toBe(true);
    expect(first[0]).not.toBe(second[0]);
    expect(first[1]).not.toBe(second[1]);
    const firstWinlink = winlinkRefForHandle(first[0]!);
    const secondWinlink = winlinkRefForHandle(first[1]!);
    if (firstWinlink === null || secondWinlink === null) {
      throw new Error("window handles require contextual winlinks");
    }
    expect(firstWinlink.windowIndex).toBe("1");
    expect(secondWinlink.windowIndex).toBe("4");
  });

  test("addresses placement mutations by captured window index", async () => {
    const fixture = runtimeFixture();
    const graph = await graphFor(fixture.runtime, [
      source("windows", "list-windows", [
        completeFormatRow({ session_id: "$1", window_id: "@9", window_index: "4" }),
        completeFormatRow({ session_id: "$1", window_id: "@8", window_index: "6" }),
      ]),
    ]);
    const projection = projectionFor(graph, "windows");
    const windows = (await materializeProjectionMembers(fixture.server, projection, graph)).filter(
      (candidate): candidate is Window => candidate instanceof Window,
    );
    const target = windows.find((candidate) => candidate.id === "@9");
    const other = windows.find((candidate) => candidate.id === "@8");
    if (target === undefined || other === undefined) throw new Error("expected two windows");
    fixture.transport.requests.length = 0;

    await target.select();
    await target.move({ index: 7 });
    await target.unlink();
    await target.removePlacement();
    await target.swapWith(other);

    expect(target.plan.removePlacement().argv).toEqual([
      "if-shell",
      "-F",
      "-t",
      "$1:4",
      "#{==:#{session_grouped},0}",
      "'unlink-window' '-k' '-t' '$1:4'",
      expect.stringMatching(/^'libtmux-grouped-session-[0-9a-f]{32}'$/u),
    ]);

    expect(fixture.transport.requests.map(flattenInvocation)).toEqual([
      ["-Lhandles", "select-window", "-t", "$1:4"],
      ["-Lhandles", "move-window", "-d", "-s", "$1:4", "-t", "$1:7"],
      ["-Lhandles", "unlink-window", "-t", "$1:4"],
      [
        "-Lhandles",
        "if-shell",
        "-F",
        "-t",
        "$1:4",
        "#{==:#{session_grouped},0}",
        "'unlink-window' '-k' '-t' '$1:4'",
        expect.stringMatching(/^'libtmux-grouped-session-[0-9a-f]{32}'$/u),
      ],
      ["-Lhandles", "swap-window", "-d", "-s", "$1:4", "-t", "$1:6"],
    ]);
  });

  test("materializes an authenticated reachable non-root relation record", async () => {
    const fixture = runtimeFixture({ alias: "reachable-relation" });
    const windowRow = completeFormatRow({
      session_id: "$1",
      window_id: "@1",
      window_index: "3",
      window_name: "reachable-window",
    });
    const graph = await graphFor(fixture.runtime, [
      source("sessions", "list-sessions", [completeFormatRow({ session_id: "$1" })]),
      source("windows", "list-windows", [windowRow]),
    ]);
    const relationDescriptors: Readonly<Record<WhereModel, ProjectionDescriptor>> = {
      ...descriptors(),
      session: {
        fields: WHERE_FIELDS_V1.session,
        model: "session",
        relations: [{ cardinality: "many", name: "windows", targetModel: "window" }],
      },
    };
    const builder = SelectionProjectionBuilder.create({
      descriptors: relationDescriptors,
      graph,
      source: createGraphSourceId("sessions"),
    });
    builder.materializeMany(graphRecordRef(graph, "sessions"), "windows", [
      graphRecordRef(graph, "windows"),
    ]);
    const projection = builder.seal();
    const relatedRecord = projection.records.find(({ model }) => model === "window");
    if (relatedRecord === undefined) throw new Error("missing reachable window record");

    expect(projection.members).toHaveLength(1);
    expect(projection.records).toHaveLength(2);
    expect(projection.members).not.toContain(relatedRecord.ref);
    const handle = (await materializeProjectionRecord(
      fixture.server,
      projection,
      graph,
      relatedRecord,
    )) as Window;

    expect(handle).toBeInstanceOf(Window);
    expect(handle.server).toBe(fixture.server);
    expect(entityRefForHandle(handle)).toBe(graphRecord(graph, "windows").entity);
    assertScalarSnapshot(handle, windowRow);
  });

  test("rejects direct runtime construction of child handles", () => {
    const guessedArguments = [new Server(), completeFormatRow(), Object.freeze({})];
    const guessedToken = Symbol("child-constructor-token");
    const guessedObject = Object.freeze({ token: guessedToken });
    const argumentLists: readonly (readonly unknown[])[] = [
      [],
      [guessedToken],
      [guessedObject],
      [guessedToken, guessedObject],
      guessedArguments,
    ];
    for (const Child of [Session, Window, Pane, Client]) {
      for (const arguments_ of argumentLists) {
        expect(() => Reflect.construct(Child, arguments_)).toThrow();
      }
    }
  });
});

describe("Python-compatible handle equality", () => {
  test("compares authentic servers and subclasses by socket selectors only", () => {
    class DerivedServer extends Server {
      readonly marker = "derived";
    }

    const left = new Server({
      colors: 88,
      configFile: "left.conf",
      environment: { LEFT: "1" },
      socketName: "same",
      tmuxBin: "left-tmux",
    });
    const right = new DerivedServer({
      colors: 256,
      configFile: "right.conf",
      environment: { RIGHT: "1" },
      socketName: "same",
      tmuxBin: "right-tmux",
    });

    expect(right).toBeInstanceOf(DerivedServer);
    expect(right.marker).toBe("derived");
    expect(runtimeForServer(right)).toBeDefined();
    expect(left.equals(right)).toBe(true);
    expect(right.equals(left)).toBe(true);
    expect(new Server().equals(new Server())).toBe(true);
    expect(
      new Server({ socketPath: "/tmp/same.sock" }).equals(
        new DerivedServer({ socketPath: "/tmp/same.sock" }),
      ),
    ).toBe(true);
    expect(left.equals(new Server({ socketName: "other" }))).toBe(false);
    expect(left.equals(new Server({ socketPath: "same" }))).toBe(false);
    expect(left.equals(Object.create(Server.prototype))).toBe(false);
    expect(left.equals({ socketName: "same", socket_path: undefined })).toBe(false);
    for (const nonServer of [null, undefined, false, 0, 1n, "same", Symbol("same")]) {
      expect(left.equals(nonServer)).toBe(false);
    }

    let trapCalls = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          trapCalls += 1;
          throw new Error("proxy getter must not run");
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error("proxy prototype trap must not run");
        },
      },
    );
    expect(left.equals(proxy)).toBe(false);
    expect(trapCalls).toBe(0);
  });

  test("rejects a revoked proxy around an authentic Server", () => {
    const left = new Server({ socketName: "same" });
    const authentic = new Server({ socketName: "same" });
    const { proxy, revoke } = Proxy.revocable(authentic, {});
    revoke();

    expect(left.equals(proxy)).toBe(false);
  });

  test("rejects construction with a foreign newTarget", () => {
    function Foreign(): void {}
    let constructed: unknown;

    expect(() => {
      constructed = Reflect.construct(Server, [{ socketName: "same" }], Foreign);
    }).toThrow(TypeError);
    expect(constructed).toBeUndefined();
  });

  test("compares Session, Window, and Pane by connection, epoch, and raw ID", async () => {
    const left = runtimeFixture({
      alias: "left",
      connection: { socketName: "left" },
      epoch: 1,
    });
    const right = runtimeFixture({
      alias: "right",
      connection: { socketName: "right" },
      epoch: 9,
    });
    const leftGraph = await graphFor(left.runtime, [
      source("sessions", "list-sessions", [
        completeFormatRow({ session_id: "$1", session_name: "left" }),
        completeFormatRow({ session_id: "$2", session_name: "different" }),
      ]),
      source("windows", "list-windows", [
        completeFormatRow({
          session_id: "$1",
          window_id: "@1",
          window_index: "1",
          window_name: "left",
        }),
        completeFormatRow({
          session_id: "$1",
          window_id: "@2",
          window_index: "2",
          window_name: "different",
        }),
      ]),
      source("panes", "list-panes", [
        completeFormatRow({
          pane_id: "%1",
          pane_title: "left",
          session_id: "$1",
          window_id: "@1",
          window_index: "1",
        }),
        completeFormatRow({
          pane_id: "%2",
          pane_title: "different",
          session_id: "$1",
          window_id: "@1",
          window_index: "1",
        }),
      ]),
    ]);
    const rightGraph = await graphFor(right.runtime, [
      source("sessions", "list-sessions", [
        completeFormatRow({ session_id: "$1", session_name: "right" }),
      ]),
      source("windows", "list-windows", [
        completeFormatRow({
          session_id: "$9",
          window_id: "@1",
          window_index: "9",
          window_name: "right",
        }),
      ]),
      source("panes", "list-panes", [
        completeFormatRow({
          pane_id: "%1",
          pane_title: "right",
          session_id: "$9",
          window_id: "@1",
          window_index: "9",
        }),
      ]),
    ]);

    const leftSessionProjection = projectionFor(leftGraph, "sessions");
    const rightSessionProjection = projectionFor(rightGraph, "sessions");
    const leftWindowProjection = projectionFor(leftGraph, "windows");
    const rightWindowProjection = projectionFor(rightGraph, "windows");
    const leftPaneProjection = projectionFor(leftGraph, "panes");
    const rightPaneProjection = projectionFor(rightGraph, "panes");
    const [
      leftSession,
      differentSession,
      rightSession,
      leftWindow,
      differentWindow,
      rightWindow,
      leftPane,
      differentPane,
      rightPane,
    ] = await Promise.all([
      materializeProjectionRecord(
        left.server,
        leftSessionProjection,
        leftGraph,
        projectionRecord(leftSessionProjection, 0),
      ),
      materializeProjectionRecord(
        left.server,
        leftSessionProjection,
        leftGraph,
        projectionRecord(leftSessionProjection, 1),
      ),
      materializeProjectionRecord(
        right.server,
        rightSessionProjection,
        rightGraph,
        projectionRecord(rightSessionProjection),
      ),
      materializeProjectionRecord(
        left.server,
        leftWindowProjection,
        leftGraph,
        projectionRecord(leftWindowProjection, 0),
      ),
      materializeProjectionRecord(
        left.server,
        leftWindowProjection,
        leftGraph,
        projectionRecord(leftWindowProjection, 1),
      ),
      materializeProjectionRecord(
        right.server,
        rightWindowProjection,
        rightGraph,
        projectionRecord(rightWindowProjection),
      ),
      materializeProjectionRecord(
        left.server,
        leftPaneProjection,
        leftGraph,
        projectionRecord(leftPaneProjection, 0),
      ),
      materializeProjectionRecord(
        left.server,
        leftPaneProjection,
        leftGraph,
        projectionRecord(leftPaneProjection, 1),
      ),
      materializeProjectionRecord(
        right.server,
        rightPaneProjection,
        rightGraph,
        projectionRecord(rightPaneProjection),
      ),
    ]);

    // A second reading of the same object on the same connection is the same
    // object, even though it is a different handle.
    const [leftSessionAgain, leftWindowAgain, leftPaneAgain] = await Promise.all([
      materializeProjectionRecord(
        left.server,
        leftSessionProjection,
        leftGraph,
        projectionRecord(leftSessionProjection, 0),
      ),
      materializeProjectionRecord(
        left.server,
        leftWindowProjection,
        leftGraph,
        projectionRecord(leftWindowProjection, 0),
      ),
      materializeProjectionRecord(
        left.server,
        leftPaneProjection,
        leftGraph,
        projectionRecord(leftPaneProjection, 0),
      ),
    ]);
    expect(leftSessionAgain).not.toBe(leftSession);
    expect(leftSession.equals(leftSessionAgain)).toBe(true);
    expect(leftWindow.equals(leftWindowAgain)).toBe(true);
    expect(leftPane.equals(leftPaneAgain)).toBe(true);

    // `$1`, `@1`, and `%1` exist on both servers and name nothing in common.
    // Answering "equal" here is how a handle from one server ends up targeting
    // an object on another.
    expect(leftSession.equals(rightSession)).toBe(false);
    expect(leftWindow.equals(rightWindow)).toBe(false);
    expect(leftPane.equals(rightPane)).toBe(false);

    // The raw-id question still has an answer; it is just a different question.
    expect((leftSession as Session).sameTmuxIdAs(rightSession as Session)).toBe(true);
    expect((leftWindow as Window).sameTmuxIdAs(rightWindow as Window)).toBe(true);
    expect((leftPane as Pane).sameTmuxIdAs(rightPane as Pane)).toBe(true);
    expect((leftSession as Session).sameTmuxIdAs(differentSession as Session)).toBe(false);

    expect(leftSession.equals(differentSession)).toBe(false);
    expect(leftWindow.equals(differentWindow)).toBe(false);
    expect(leftPane.equals(differentPane)).toBe(false);
    expect(leftSession.equals(leftWindow)).toBe(false);
    expect(leftWindow.equals(leftPane)).toBe(false);
    assertRejectsNonAuthenticEquality(leftSession as Session, Session.prototype);
    assertRejectsNonAuthenticEquality(leftWindow as Window, Window.prototype);
    assertRejectsNonAuthenticEquality(leftPane as Pane, Pane.prototype);

    let trapCalls = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          trapCalls += 1;
          throw new Error("proxy getter must not run");
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error("proxy prototype trap must not run");
        },
      },
    );
    expect(leftSession.equals(proxy)).toBe(false);
    expect(leftWindow.equals(proxy)).toBe(false);
    expect(leftPane.equals(proxy)).toBe(false);
    expect(trapCalls).toBe(0);
  });

  test("compares Client by exact class, Server equality, and all 178 fields", async () => {
    const fixture = runtimeFixture({ connection: { socketName: "client-equality" } });
    const baselineRow = completeFormatRow({
      client_name: "client-base",
      pane_id: "%1",
      session_id: "$1",
      window_id: "@1",
      window_index: "1",
    });
    const changedRows = FORMAT_FIELD_TOKENS.map((token) =>
      completeFormatRow({ ...baselineRow, [token]: validChangedValue(token) }),
    );
    const graph = await graphFor(fixture.runtime, [
      source("clients", "list-clients", [baselineRow, ...changedRows]),
    ]);
    const refs = graph.sources[0]?.records;
    if (refs === undefined) throw new Error("missing client equality source");
    const [baseline, ...changed] = await Promise.all(
      refs.map((ref) => materializeClientRecord(fixture.server, graph, ref)),
    );
    if (baseline === undefined) throw new Error("missing baseline client");

    expect(changed).toHaveLength(FORMAT_FIELD_TOKENS.length);
    for (const [index, candidate] of changed.entries()) {
      expect(baseline.equals(candidate), FORMAT_FIELD_TOKENS[index]).toBe(false);
    }

    const equalFixture = runtimeFixture({
      alias: "equal-client-other-runtime",
      epoch: 12,
      connection: { socketName: "client-equality" },
    });
    const equalGraph = await graphFor(equalFixture.runtime, [
      source("equal-client", "list-clients", [completeFormatRow({ ...baselineRow })]),
    ]);
    const equal = await materializeClientRecord(
      equalFixture.server,
      equalGraph,
      graphRecordRef(equalGraph, "equal-client"),
    );
    expect(baseline).not.toBe(equal);
    expect(baseline.equals(equal)).toBe(true);
    expect(equal.equals(baseline)).toBe(true);

    const otherServerFixture = runtimeFixture({ connection: { socketName: "other-server" } });
    const otherServerGraph = await graphFor(otherServerFixture.runtime, [
      source("other-client", "list-clients", [completeFormatRow({ ...baselineRow })]),
    ]);
    const otherServerClient = await materializeClientRecord(
      otherServerFixture.server,
      otherServerGraph,
      graphRecordRef(otherServerGraph, "other-client"),
    );
    expect(baseline.equals(otherServerClient)).toBe(false);
    assertRejectsNonAuthenticEquality(baseline, Client.prototype);

    const ClientBase = Client as unknown as abstract new () => Client;
    class DerivedClient extends ClientBase {}
    const derivedLookalike = Object.create(DerivedClient.prototype) as Client;
    expect(baseline.equals(derivedLookalike)).toBe(false);
    expect(baseline.equals({ ...baselineRow, server: fixture.server })).toBe(false);

    let trapCalls = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          trapCalls += 1;
          throw new Error("proxy getter must not run");
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error("proxy prototype trap must not run");
        },
      },
    );
    expect(baseline.equals(proxy)).toBe(false);
    expect(trapCalls).toBe(0);
  });
});
