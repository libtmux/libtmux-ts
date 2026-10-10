import { isAbsolute } from "node:path";

export interface NamedSocketDirectory {
  readonly path: string;
  readonly uid: number;
}

export interface CapturedEndpoint {
  readonly socketPath: string;
  readonly socketName: string | undefined;
  readonly socketDirectory: NamedSocketDirectory | undefined;
}

function absolutePath(value: string, name: string): string {
  if (value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path without NUL`);
  }
  return value;
}

/** Read from the right so commas in a socket path survive. */
export function tmuxContextSocket(value: string): string {
  const last = value.lastIndexOf(",");
  const previous = last < 0 ? -1 : value.lastIndexOf(",", last - 1);
  const pid = value.slice(previous + 1, last);
  const session = value.slice(last + 1);
  if (
    previous <= 0 ||
    !/^\d+$/u.test(pid) ||
    /^0+$/u.test(pid) ||
    !/^(?:\$?\d+|-1)$/u.test(session)
  ) {
    throw new TypeError("TMUX is malformed");
  }
  return absolutePath(value.slice(0, previous), "TMUX socket path");
}

function namedEndpoint(
  socketName: string,
  environment: Readonly<Record<string, string | undefined>>,
): CapturedEndpoint {
  if (
    socketName === "" ||
    socketName === "." ||
    socketName === ".." ||
    /[/\\\0]/u.test(socketName)
  ) {
    throw new TypeError("socket name must be a nonempty leaf name other than '.' or '..'");
  }
  const configuredRoot = environment.TMUX_TMPDIR;
  const root = absolutePath(
    configuredRoot === undefined || configuredRoot === "" ? "/tmp" : configuredRoot,
    "TMUX_TMPDIR",
  );
  if (process.getuid === undefined) {
    throw new TypeError("named tmux sockets require a Unix user ID; supply an explicit socketPath");
  }
  const uid = process.getuid();
  // Lexical normalization can erase a missing component or change symlink/.. semantics.
  const path = `${root.endsWith("/") ? root : `${root}/`}tmux-${String(uid)}`;
  return {
    socketName,
    socketPath: `${path}/${socketName}`,
    socketDirectory: Object.freeze({ path, uid }),
  };
}

/** Select once; a rejected selected value cannot redirect the handle to a fallback. */
export function resolveEndpoint(
  options: { readonly socketPath?: string; readonly socketName?: string },
  environment: Readonly<Record<string, string | undefined>>,
): CapturedEndpoint {
  if (options.socketPath !== undefined && options.socketName !== undefined) {
    throw new TypeError("socketName and socketPath are mutually exclusive");
  }
  const fromPath = (path: string): CapturedEndpoint => ({
    socketPath: absolutePath(path, "socketPath"),
    socketName: undefined,
    socketDirectory: undefined,
  });
  if (options.socketPath !== undefined) return fromPath(options.socketPath);
  if (options.socketName !== undefined) return namedEndpoint(options.socketName, environment);
  if (environment.LIBTMUX_SOCKET_PATH !== undefined && environment.LIBTMUX_SOCKET_PATH !== "") {
    return fromPath(environment.LIBTMUX_SOCKET_PATH);
  }
  if (environment.LIBTMUX_SOCKET_NAME !== undefined && environment.LIBTMUX_SOCKET_NAME !== "") {
    return namedEndpoint(environment.LIBTMUX_SOCKET_NAME, environment);
  }
  if (environment.TMUX !== undefined && environment.TMUX !== "") {
    return fromPath(tmuxContextSocket(environment.TMUX));
  }
  return namedEndpoint("default", environment);
}
