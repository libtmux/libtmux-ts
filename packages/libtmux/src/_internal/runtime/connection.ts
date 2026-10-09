import { resolveEndpoint, type NamedSocketDirectory } from "./endpoint.js";

export interface TmuxConnectionOptions {
  readonly colors?: 256;
  readonly configFile?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly socketName?: string;
  readonly socketPath?: string;
}

export class TmuxConnection {
  readonly colors: 256 | undefined;
  readonly configFile: string | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly socketName: string | undefined;
  readonly socketPath: string;
  readonly socketDirectory: NamedSocketDirectory | undefined;

  constructor(options: TmuxConnectionOptions) {
    if (options.colors !== undefined && options.colors !== 256) {
      throw new TypeError("colors must be 256 or omitted");
    }
    const environment = { ...options.environment };
    const endpoint = resolveEndpoint(options, environment);
    delete environment.TMUX;
    delete environment.TMUX_PANE;

    this.colors = options.colors;
    this.configFile = options.configFile;
    this.environment = Object.freeze(environment);
    this.executable = options.executable;
    this.socketName = endpoint.socketName;
    this.socketPath = endpoint.socketPath;
    this.socketDirectory = endpoint.socketDirectory;
    Object.freeze(this);
  }
}
