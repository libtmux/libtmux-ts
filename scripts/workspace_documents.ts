/**
 * The documents this repository checks above the library package.
 *
 * Its own module because two scripts read it — one compiles these blocks and
 * one runs them — and both are executable scripts. Importing either for the
 * list would run it.
 */
export const workspaceDocuments: readonly string[] = [
  "README.md",
  "examples/README.md",
  "packages/mcp/README.md",
  "packages/workspace/README.md",
  // Generated, and its examples were compiled by nothing: the package's own
  // gate reads its README, and this one read everything above the package. A
  // reference that teaches a call is as wrong as a README that does.
  "packages/libtmux/docs/criteria.md",
];
