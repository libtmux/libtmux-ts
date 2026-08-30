import type { Session } from "libtmux/session";

/**
 * Which sessions this package may take things away from.
 *
 * A workspace finds its session by name, and a name is not a claim: `dev` in a
 * config file and `dev` a person started by hand are the same lookup, and
 * converging the second means killing windows nobody described. So creating a
 * session marks it, and pruning asks the mark rather than the name.
 *
 * The mark is a tmux user option on the session, which is where it has to live:
 * it must survive this process exiting, be readable by whatever runs next, and
 * disappear with the session it describes. Nothing else on the server has that
 * lifetime.
 */

/** The option a workspace stamps on the sessions it created. */
export const OWNERSHIP_OPTION = "@libtmux-workspace";

/** What to do with windows and panes the workspace does not describe. */
export type PrunePolicy = "always" | "never" | "owned";

/** Whether this session carries the mark for `name`. */
export async function ownedByWorkspace(session: Session, name: string): Promise<boolean> {
  const options = await session.showOptions();
  return options.get(OWNERSHIP_OPTION) === name;
}

/** Claim a session this apply created. */
export async function claimSession(session: Session, name: string): Promise<void> {
  await session.setOption(OWNERSHIP_OPTION, name);
}

/**
 * Whether surplus topology may be removed.
 *
 * `owned` is the default because it is the only one that is safe without
 * knowing where the session came from: a workspace prunes what it built and
 * leaves alone what it merely found. `always` authorizes pruning for one
 * operation; it does not stamp or otherwise adopt the session.
 */
export function mayPrune(policy: PrunePolicy, owned: boolean): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  return owned;
}
