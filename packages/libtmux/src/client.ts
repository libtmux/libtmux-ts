import { CLIENT_ALIASES } from "./_generated/field_aliases.js";
import type { AliasedFields, ClientAliasMap, RowWithIdentities } from "./field_types.js";
import { paneOfPlacement, sessionOf, windowOfPlacement } from "./_internal/operations/relations.js";
import { refreshedHandle } from "./_internal/operations/refreshed.js";
import { detachClient, switchClient } from "./_internal/operations/shell.js";
import { originGraphForHandle } from "./_internal/runtime/live_handle.js";
import type { Pane } from "./pane.js";
import type { Session } from "./session.js";
import type { Window } from "./window.js";
import {
  installLiveHandlePrototype,
  liveHandlesEqual,
  runtimeForHandle,
} from "./_internal/runtime/live_handle.js";
import type { Server } from "./server.js";

// eslint-disable-next-line typescript/no-unsafe-declaration-merging -- CompleteFormatRow declaration merging exposes the frozen scalar snapshot on the nominal handle.
/**
 * One client attached to a tmux server, as a handle rather than a copy of it.
 *
 * Reached from {@link Server.clients}; the constructor throws. A client is the
 * shortest-lived thing here — it goes away when its terminal does — so
 * {@link Client.session} reports `undefined` once it has detached, and every
 * other read reflects the moment the handle was made.
 */
export class Client {
  declare private readonly clientBrand: undefined;
  /**
   * The server this handle addresses.
   *
   * ```ts
   * client.server.socketPath;
   * ```
   */
  declare readonly server: Server;

  private constructor() {
    throw new Error("Client cannot be constructed directly");
  }

  /**
   * The session this client is attached to, if it is still attached.
   *
   * ```ts
   * client.session?.name;
   * ```
   */
  get session(): Session | undefined {
    return sessionOf(originGraphForHandle(this), this.format.session_id);
  }

  /**
   * The window placement this client currently shows.
   *
   * ```ts
   * client.window?.name;
   * ```
   */
  get window(): Window | undefined {
    return windowOfPlacement(originGraphForHandle(this), this);
  }

  /**
   * The pane this client currently has active.
   *
   * ```ts
   * client.pane?.id;
   * ```
   */
  get pane(): Pane | undefined {
    return paneOfPlacement(originGraphForHandle(this), this);
  }

  /**
   * This client, read again at a new instant.
   *
   * ```ts
   * const later = await client.refreshed();
   * later.session?.name;
   * ```
   */
  refreshed(): Promise<Client> {
    return refreshedHandle(this, runtimeForHandle(this));
  }

  /**
   * Detach this client from its server.
   *
   * ```ts
   * await client.detach();
   * ```
   */
  detach(): Promise<void> {
    return detachClient(runtimeForHandle(this), { client: this.name });
  }

  /**
   * Point this client at a different session.
   *
   * ```ts
   * await client.switchTo(session);
   * ```
   */
  switchTo(session: Session): Promise<void> {
    return switchClient(runtimeForHandle(this), this.name, session.id);
  }

  equals(other: unknown): boolean {
    return liveHandlesEqual(this, other);
  }
}

/**
 * The tmux format fields a client handle is built from, by tmux's own names.
 *
 * Read through `format` when the aliased property names on the handle are not
 * what a caller wants — a field tmux added in a later version has a token
 * here whether or not this library has given it a name.
 */
type ClientRow = RowWithIdentities<"client_name">;

export interface Client extends AliasedFields<ClientRow, ClientAliasMap> {
  /**
   * How this handle renders in a log line, a template literal, or an error.
   *
   * Installed with the rest of the live-handle prototype, and declared here so
   * the emitted types advertise it and a caller's own lint does not report the
   * default `[object Object]`.
   */
  toString(): string;
  /** The raw tmux format row, addressed by tmux's own token names. */
  readonly format: ClientRow;
}

installLiveHandlePrototype(Client.prototype, CLIENT_ALIASES);
