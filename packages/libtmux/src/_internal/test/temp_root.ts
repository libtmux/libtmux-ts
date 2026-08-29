import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One prefix this package owns, for every temporary directory its suites make.
 *
 * Other libtmux ports run their suites on this machine, and `/tmp/libtmux-*`
 * is not this package's to take — `/tmp/libtmux-java-test` and
 * `/tmp/libtmux-swift-dev` were both sitting there when this was written, and
 * nineteen call sites here reached for exactly that shape. A cleanup sweep in
 * either direction could reap the other's tmux servers.
 *
 * Ownership is a prefix rather than a parent directory, and that is the whole
 * design. Nesting everything one level deeper was tried first and cost fifteen
 * bytes of the socket budget below: the longest fixture path went to 104 and
 * the suite failed with "File name too long", which is the confusion this
 * limit is documented to cause rather than anything about sockets. A prefix
 * costs nothing, and `ltx` is already what every suite here was using.
 */

/**
 * tmux refuses a socket path longer than this. Declared beside the naming rule
 * that has to fit inside it, and re-exported by the testkit for its callers.
 */
export const SOCKET_PATH_UTF8_LIMIT = 103;

/** Everything this package creates in the temporary directory starts with it. */
const TEST_PREFIX = "ltx";

const ownedRoot = join(tmpdir(), TEST_PREFIX);

/**
 * A fresh directory named for what is using it.
 *
 * `mkdtemp` supplies the unique suffix, so two runs never collide; the prefix
 * says which suite to blame when one survives a crash, and is required to
 * carry the package's own so a sweep can tell them apart from another port's.
 */
export async function makeTestDirectory(prefix: string): Promise<string> {
  if (!prefix.startsWith(TEST_PREFIX)) {
    throw new Error(
      `test directory prefix ${JSON.stringify(prefix)} must start with ${JSON.stringify(TEST_PREFIX)}, so a sweep can tell this package's temporary directories from another libtmux port's`,
    );
  }
  return mkdtemp(join(tmpdir(), prefix));
}

/** Whether a path is one this package created, rather than another port's. */
function isOwnedTestPath(path: string): boolean {
  return path.startsWith(ownedRoot);
}

/**
 * Every temporary directory this package created, for a sweep to look inside.
 *
 * The prefix is the only thing separating these from another libtmux port's, so
 * enumeration belongs beside the rule that assigns it rather than in each
 * caller. A symlink is never followed: `readdir` reports a link as a link, and
 * only real directories are returned.
 */
export async function ownedTestDirectories(): Promise<readonly string[]> {
  const parent = tmpdir();
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isOwnedTestPath(join(parent, entry.name)))
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

/**
 * Refuse a fixture socket that is not this package's to use.
 *
 * The suites create sessions, send keys, and kill what they made. Pointed at
 * an ambient server they would do all of that to whatever the developer is
 * attached to, and the fixture sweep would reap it afterwards. Every suite
 * that starts a live server calls this before it touches one, so the isolation
 * fails loudly rather than being a thing everyone remembers.
 */
export function assertOwnedSocketPath(socketPath: string): void {
  if (!isOwnedTestPath(socketPath)) {
    throw new Error(
      `fixture socket ${socketPath} is not under ${ownedRoot}*: a suite must never touch a server it does not own`,
    );
  }
  const ambient = process.env.TMUX?.split(",")[0];
  if (ambient !== undefined && ambient === socketPath) {
    throw new Error(`fixture socket ${socketPath} is the tmux server this process is attached to`);
  }
  if (Buffer.byteLength(socketPath, "utf8") > SOCKET_PATH_UTF8_LIMIT) {
    throw new Error(`fixture socket path exceeds ${String(SOCKET_PATH_UTF8_LIMIT)} bytes`);
  }
}
