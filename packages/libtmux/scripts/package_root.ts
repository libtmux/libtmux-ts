import { fileURLToPath } from "node:url";

/**
 * This package's root directory.
 *
 * It lives on its own because its readers have nothing else in common: the API
 * surface reader, two documentation generators, and the example checkers all
 * need to resolve a path against the package, and none of them needs anything
 * the others do. Kept inside the example harness, it made three scripts that
 * check no examples import one that does.
 */
export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
