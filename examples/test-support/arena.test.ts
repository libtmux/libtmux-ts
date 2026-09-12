import { describe, expect, test } from "bun:test";

import { arenaRoute } from "./arena.js";

// A stand-in artifact id: these tests exercise the routing rules the helper
// enforces for every artifact, not anything specific to one example.
const ARTIFACT = "typescript-quickstart";

describe("arenaRoute", () => {
  test("keeps the fixture when arena aliases are inactive", () => {
    expect(
      arenaRoute(ARTIFACT, {
        LIBTMUX_ARENA_ARTIFACT: ARTIFACT,
        LIBTMUX_SOCKET_PATH: "/not-an-arena-socket",
        LIBTMUX_TMUX_BIN: "/not-an-arena-tmux",
      }),
    ).toEqual({ kind: "fixture" });
  });

  test("keeps the fixture when the arena descriptor is empty", () => {
    expect(
      arenaRoute(ARTIFACT, {
        LIBTMUX_ARENA_DESCRIPTOR: "",
        LIBTMUX_ARENA_ARTIFACT: ARTIFACT,
        LIBTMUX_SOCKET_PATH: "/not-an-arena-socket",
        LIBTMUX_TMUX_BIN: "/not-an-arena-tmux",
      }),
    ).toEqual({ kind: "fixture" });
  });

  test("rejects an activated incomplete or mismatched arena before creating a server", () => {
    for (const [environment, message] of [
      [{ LIBTMUX_ARENA_DESCRIPTOR: "arena" }, "arena contract is incomplete"],
      [
        {
          LIBTMUX_ARENA_DESCRIPTOR: "arena",
          LIBTMUX_ARENA_ARTIFACT: "",
          LIBTMUX_SOCKET_PATH: "/arena.sock",
          LIBTMUX_TMUX_BIN: "/usr/bin/tmux",
        },
        "arena contract is incomplete",
      ],
      [
        {
          LIBTMUX_ARENA_DESCRIPTOR: "arena",
          LIBTMUX_ARENA_ARTIFACT: ARTIFACT,
          LIBTMUX_SOCKET_PATH: "",
          LIBTMUX_TMUX_BIN: "/usr/bin/tmux",
        },
        "arena contract is incomplete",
      ],
      [
        {
          LIBTMUX_ARENA_DESCRIPTOR: "arena",
          LIBTMUX_ARENA_ARTIFACT: ARTIFACT,
          LIBTMUX_SOCKET_PATH: "/arena.sock",
          LIBTMUX_TMUX_BIN: "",
        },
        "arena contract is incomplete",
      ],
      [
        {
          LIBTMUX_ARENA_DESCRIPTOR: "arena",
          LIBTMUX_ARENA_ARTIFACT: "other-example",
          LIBTMUX_SOCKET_PATH: "/arena.sock",
          LIBTMUX_TMUX_BIN: "/usr/bin/tmux",
        },
        `arena artifact does not select ${ARTIFACT}`,
      ],
    ] as const) {
      expect(() => arenaRoute(ARTIFACT, environment)).toThrow(message);
    }
  });
});
