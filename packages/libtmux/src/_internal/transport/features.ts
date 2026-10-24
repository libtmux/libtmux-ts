import { TmuxTransportError, VersionTooLowError } from "../../errors.js";
import type { TmuxCommand } from "../../engine.js";
import { type TmuxVersion } from "../runtime/tmux_version.js";
import {
  capabilitySince,
  hasCapability,
  workaroundApplies,
  type CapabilityId,
  type WorkaroundId,
} from "../support/capabilities.js";

/** Every command name and its alias, so an abbreviation resolves the way tmux resolves it. */
const COMMANDS: readonly (readonly [canonical: string, alias?: string])[] = [
  ["attach-session", "attach"],
  ["bind-key", "bind"],
  ["break-pane", "breakp"],
  ["capture-pane", "capturep"],
  ["choose-buffer"],
  ["choose-client"],
  ["choose-tree"],
  ["clear-history", "clearhist"],
  ["clear-prompt-history", "clearphist"],
  ["clock-mode"],
  ["command-prompt"],
  ["confirm-before", "confirm"],
  ["copy-mode"],
  ["customize-mode"],
  ["delete-buffer", "deleteb"],
  ["detach-client", "detach"],
  ["display-menu", "menu"],
  ["display-message", "display"],
  ["display-popup", "popup"],
  ["display-panes", "displayp"],
  ["find-window", "findw"],
  ["has-session", "has"],
  ["if-shell", "if"],
  ["join-pane", "joinp"],
  ["kill-pane", "killp"],
  ["kill-server"],
  ["kill-session"],
  ["kill-window", "killw"],
  ["last-pane", "lastp"],
  ["last-window", "last"],
  ["link-window", "linkw"],
  ["list-buffers", "lsb"],
  ["list-clients", "lsc"],
  ["list-commands", "lscm"],
  ["list-keys", "lsk"],
  ["list-panes", "lsp"],
  ["list-sessions", "ls"],
  ["list-windows", "lsw"],
  ["load-buffer", "loadb"],
  ["lock-client", "lockc"],
  ["lock-server", "lock"],
  ["lock-session", "locks"],
  ["move-pane", "movep"],
  ["move-window", "movew"],
  ["new-pane", "newp"],
  ["new-session", "new"],
  ["new-window", "neww"],
  ["next-layout", "nextl"],
  ["next-window", "next"],
  ["paste-buffer", "pasteb"],
  ["pipe-pane", "pipep"],
  ["previous-layout", "prevl"],
  ["previous-window", "prev"],
  ["refresh-client", "refresh"],
  ["rename-session", "rename"],
  ["rename-window", "renamew"],
  ["resize-pane", "resizep"],
  ["resize-window", "resizew"],
  ["respawn-pane", "respawnp"],
  ["respawn-window", "respawnw"],
  ["rotate-window", "rotatew"],
  ["run-shell", "run"],
  ["save-buffer", "saveb"],
  ["select-layout", "selectl"],
  ["select-pane", "selectp"],
  ["select-window", "selectw"],
  ["send-keys", "send"],
  ["send-prefix"],
  ["server-access"],
  ["set-buffer", "setb"],
  ["set-environment", "setenv"],
  ["set-hook"],
  ["set-option", "set"],
  ["set-window-option", "setw"],
  ["show-buffer", "showb"],
  ["show-environment", "showenv"],
  ["show-hooks"],
  ["show-messages", "showmsgs"],
  ["show-options", "show"],
  ["show-prompt-history", "showphist"],
  ["show-window-options", "showw"],
  ["source-file", "source"],
  ["split-window", "splitw"],
  ["start-server", "start"],
  ["suspend-client", "suspendc"],
  ["swap-pane", "swapp"],
  ["swap-window", "swapw"],
  ["switch-client", "switchc"],
  ["switch-mode"],
  ["unbind-key", "unbind"],
  ["unlink-window", "unlinkw"],
  ["wait-for", "wait"],
];

/** The canonical command a name resolves to: exact, alias, or the one command it prefixes. */
function resolve(name: string): string | undefined {
  const exact = COMMANDS.find(([canonical, alias]) => name === canonical || name === alias);
  if (exact !== undefined) return exact[0];
  const prefixed = COMMANDS.filter(([canonical]) => canonical.startsWith(name));
  return name !== "" && prefixed.length === 1 ? prefixed[0]![0] : undefined;
}

interface Parsed {
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
}

/** Read tmux-style flags; `valued` names the ones that take the next word. */
function parse(args: readonly string[], valued: string): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      positionals.push(word);
      continue;
    }
    for (let at = 1; at < word.length; at += 1) {
      const flag = word[at]!;
      if (valued.includes(flag)) {
        const inline = word.slice(at + 1);
        flags.set(flag, inline === "" ? (args[(index += 1)] ?? "") : inline);
        break;
      }
      flags.set(flag, true);
    }
  }
  return { flags, positionals };
}

const PRESETS = ["even-horizontal", "even-vertical", "main-horizontal", "main-vertical", "tiled"];

function refuse(subcommand: string, message: string): TmuxTransportError {
  return new TmuxTransportError(message, { delivery: "not_started", kind: "protocol", subcommand });
}

function requires(feature: string, id: CapabilityId, running: TmuxVersion): VersionTooLowError {
  return new VersionTooLowError({
    criteriaName: feature,
    delivery: "not_started",
    serverVersion: running.raw,
    since: capabilitySince(id).raw,
  });
}

function badName(value: string | true | undefined): boolean {
  return typeof value === "string" && /[:.]/u.test(value);
}

/**
 * Refuse a literal command the running release mishandles, before it is sent.
 *
 * Library-selected operations meet the same rules where they are built; this
 * covers argv a caller wrote, alone or in a list. A command reaches here only
 * as structured words, so nothing is parsed out of a script.
 */
export function guardFeatures(running: TmuxVersion, commands: readonly TmuxCommand[]): void {
  const lacks = (id: CapabilityId): boolean => !hasCapability(id, running);
  const has = (id: WorkaroundId): boolean => workaroundApplies(id, running);
  for (const [word, ...args] of commands) {
    const name = resolve(word);
    if (
      name === "delete-buffer" &&
      lacks("buffer-delete-named") &&
      parse(args, "b").flags.has("b")
    ) {
      throw requires("deleting a named buffer", "buffer-delete-named", running);
    }
    if (name === "set-buffer" && lacks("buffer-rename") && parse(args, "bnt").flags.has("n")) {
      throw requires("renaming a buffer", "buffer-rename", running);
    }
    // tmux 3.3a stops when it asks an attached xterm-256color or tmux-256color
    // terminal for its clipboard.
    if (
      name === "refresh-client" &&
      lacks("clipboard-query") &&
      parse(args, "ABCFft").flags.has("l")
    ) {
      throw requires("asking a terminal for its clipboard", "clipboard-query", running);
    }
    if (name === "select-layout" && lacks("layout-without-checksum")) {
      const { flags, positionals } = parse(args, "t");
      const layout = positionals[0];
      const reads = !["n", "o", "p", "E"].some((flag) => flags.has(flag));
      const known =
        layout === undefined ||
        !reads ||
        /^[0-9a-f]{4},/iu.test(layout) ||
        PRESETS.includes(layout) ||
        (layout !== "" && PRESETS.filter((preset) => preset.startsWith(layout)).length === 1);
      if (!known) {
        throw refuse(
          word,
          `tmux ${running.raw} crashes on a layout it cannot parse; ${JSON.stringify(layout)} is not a preset or a checksummed layout`,
        );
      }
    }
    if (
      name === "split-window" &&
      has("split-window-percent-size") &&
      parse(args, "cetFlp").flags.has("p")
    ) {
      throw refuse(word, "tmux 3.4 splits wrongly with -p; write the size as -l N%");
    }
    if (name === "break-pane" && has("break-pane-misnames-windows")) {
      const { flags } = parse(args, "Fnst");
      if (!flags.has("n")) {
        throw refuse(
          word,
          "tmux 3.7 crashes the server on a break-pane without -n; pass a window name",
        );
      }
      if (flags.has("n") && !flags.has("P")) {
        throw refuse(
          word,
          "tmux 3.7 accepts break-pane -n and ignores it; name the window afterwards, or print its id with -P",
        );
      }
    }
    if (has("name-separators-rejected")) {
      if (name === "break-pane" && badName(parse(args, "Fnst").flags.get("n"))) {
        throw refuse(word, "tmux 3.7 rejects window names containing ':' or '.'");
      }
      if (name === "new-session") {
        const { flags } = parse(args, "cefFnstxy");
        if (badName(flags.get("s")) || badName(flags.get("n"))) {
          throw refuse(word, "tmux 3.7 rejects session and window names containing ':' or '.'");
        }
      }
      if (name === "new-window" && badName(parse(args, "cefFnt").flags.get("n"))) {
        throw refuse(word, "tmux 3.7 rejects window names containing ':' or '.'");
      }
      if (name === "rename-session" || name === "rename-window") {
        if (badName(parse(args, "t").positionals.at(-1))) {
          throw refuse(word, "tmux 3.7 rejects names containing ':' or '.'");
        }
      }
    }
  }
}
