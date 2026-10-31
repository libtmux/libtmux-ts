export interface TmuxConnectionOptions {
  readonly colors?: 256;
  readonly configFile?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly socketName?: string;
  readonly socketPath?: string;
}

/** The socket the environment names, which is none unless a variable is set to something. */
export interface EnvironmentSocket {
  readonly socketName?: string;
  readonly socketPath?: string;
}

/**
 * Read `LIBTMUX_SOCKET_PATH`, else `LIBTMUX_SOCKET`.
 *
 * tmux ignores `-L` when `-S` is given, so the path is the one that wins when
 * both are set. A variable that is empty or only whitespace counts as unset,
 * each one alone; any other value is used as written.
 */
export function socketFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): EnvironmentSocket {
  const path = environment.LIBTMUX_SOCKET_PATH;
  if (path !== undefined && path.trim() !== "") return { socketPath: path };
  const name = environment.LIBTMUX_SOCKET;
  if (name !== undefined && name.trim() !== "") return { socketName: name };
  return {};
}

export class TmuxConnection {
  readonly colors: 256 | undefined;
  readonly configFile: string | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly socketName: string | undefined;
  readonly socketPath: string | undefined;

  constructor(options: TmuxConnectionOptions) {
    if (options.colors !== undefined && options.colors !== 256) {
      throw new TypeError("colors must be 256 or omitted");
    }
    if (options.socketName !== undefined && options.socketPath !== undefined) {
      throw new TypeError("socketName and socketPath are mutually exclusive");
    }

    this.colors = options.colors;
    this.configFile = options.configFile;
    this.environment = Object.freeze({ ...options.environment });
    this.executable = options.executable;
    this.socketName = options.socketName;
    this.socketPath = options.socketPath;
    Object.freeze(this);
  }
}
