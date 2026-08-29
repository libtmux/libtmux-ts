import { parsePaneId, parseSessionId, parseWindowId } from "../../src/_internal/runtime/ids.js";
import type {
  Client,
  Pane,
  PaneId,
  PaneIdInput,
  Session,
  SessionId,
  SessionIdInput,
  Window,
  WindowId,
  WindowIdInput,
} from "../../src/index.js";

declare const raw: string;

const rawSession: SessionIdInput = "$1";
const session = parseSessionId(rawSession);
const pane = parsePaneId("%3");
const window = parseWindowId("@2");

const sessionInput: SessionIdInput = session;
const paneInput: PaneIdInput = pane;
const windowInput: WindowIdInput = window;

void sessionInput;
void paneInput;
void windowInput;
parseSessionId("$1");
parseSessionId(raw);
parseSessionId(session);
parseWindowId("@2");
parseWindowId(raw);
parseWindowId(window);
parsePaneId("%3");
parsePaneId(raw);
parsePaneId(pane);

// @ts-expect-error A pane brand cannot be supplied where a session ID is expected.
parseSessionId(pane);
// @ts-expect-error A window brand cannot be supplied where a session ID is expected.
parseSessionId(window);
// @ts-expect-error A session brand cannot be supplied where a window ID is expected.
parseWindowId(session);
// @ts-expect-error A pane brand cannot be supplied where a window ID is expected.
parseWindowId(pane);
// @ts-expect-error A session brand cannot be supplied where a pane ID is expected.
parsePaneId(session);
// @ts-expect-error A window brand cannot be supplied where a pane ID is expected.
parsePaneId(window);

declare const mixed: typeof session | typeof pane;

// @ts-expect-error A union containing a foreign brand cannot be supplied as a session ID.
parseSessionId(mixed);

declare const mixedWindow: typeof window | typeof session;
declare const mixedPane: typeof pane | typeof window;

// @ts-expect-error A union containing a foreign brand cannot be supplied as a window ID.
parseWindowId(mixedWindow);
// @ts-expect-error A union containing a foreign brand cannot be supplied as a pane ID.
parsePaneId(mixedPane);

const erased: string = pane;
parseSessionId(erased);
parseWindowId(erased);
parsePaneId(erased);

declare const clientHandle: Client;
declare const paneHandle: Pane;
declare const sessionHandle: Session;
declare const windowHandle: Window;

const sessionOutput: SessionId = sessionHandle.id;
const windowOutput: WindowId = windowHandle.id;
const paneOutput: PaneId = paneHandle.id;
const placedSessionOutput: SessionId = windowHandle.format.session_id;
const paneSessionOutput: SessionId = paneHandle.format.session_id;
const paneWindowOutput: WindowId = paneHandle.format.window_id;
const clientPaneOutput: PaneId | "" | null = clientHandle.format.pane_id;

const rawSessionOutput: SessionId = sessionHandle.format.session_id;
const rawWindowOutput: WindowId = windowHandle.format.window_id;
const rawPaneOutput: PaneId = paneHandle.format.pane_id;
const optionalRawPaneOutput: PaneId | "" | null = sessionHandle.format.pane_id;
const nextSessionOutput: SessionId | null = sessionHandle.nextSessionId;
const rawNextSessionOutput: SessionId | "" | null = sessionHandle.format.next_session_id;

void [
  sessionOutput,
  windowOutput,
  paneOutput,
  placedSessionOutput,
  paneSessionOutput,
  paneWindowOutput,
  clientPaneOutput,
  rawSessionOutput,
  rawWindowOutput,
  rawPaneOutput,
  optionalRawPaneOutput,
  nextSessionOutput,
  rawNextSessionOutput,
];

const dynamicSessionInput: SessionIdInput = raw;
const dynamicWindowInput: WindowIdInput = raw;
const dynamicPaneInput: PaneIdInput = raw;
void [dynamicSessionInput, dynamicWindowInput, dynamicPaneInput];

// @ts-expect-error A branded pane output remains invalid session input.
const wrongSessionInput: SessionIdInput = paneHandle.id;
// @ts-expect-error A branded session output remains invalid window input.
const wrongWindowInput: WindowIdInput = sessionHandle.id;
// @ts-expect-error A branded window output remains invalid pane input.
const wrongPaneInput: PaneIdInput = windowHandle.id;
void [wrongSessionInput, wrongWindowInput, wrongPaneInput];
