import { Client } from "../../client.js";
import { Pane } from "../../pane.js";
import { Server } from "../../server.js";
import { Session } from "../../session.js";
import { Window } from "../../window.js";
import type { RuntimeConstructors } from "../runtime/constructors.js";

export const TEST_HANDLE_PROTOTYPES: RuntimeConstructors = Object.freeze({
  client: Client.prototype,
  pane: Pane.prototype,
  server: Server.prototype,
  session: Session.prototype,
  window: Window.prototype,
});
