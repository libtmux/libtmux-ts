import { describe, expect, test } from "bun:test";

import {
  serverFor,
  shellPaneId,
  structured,
  toolText,
  withClient,
  withServer,
} from "./support/server_harness.js";

describe("staying out of the way", () => {
  test("refuses to run a command in a dead pane", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      await withClient(fixture, async (client) => {
        const session = (await tmux.snapshot()).sessions.one().name ?? "";
        const made = structured<{ paneId: string; window: { id: string } }>(
          await client.callTool({
            arguments: { name: "doomed", session },
            name: "new_window",
          }),
        );
        // remain-on-exit is a window option, which this server cannot yet
        // reach — the library can, and the fixture needs a pane that stays
        // after its process exits.
        const window = (await tmux.snapshot()).windows.one({
          id: made.window.id,
        });
        await window.setOption("remain-on-exit", "on");

        await client.callTool({
          arguments: { enter: true, keys: "exit 7", paneId: made.paneId },
          name: "send_keys",
        });
        const deadline = Date.now() + 10_000;
        let pane: { dead: boolean } = { dead: false };
        while (!pane.dead && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop -- each call observes a later process state.
          const answer = await client.callTool({
            arguments: { paneId: made.paneId },
            name: "get_pane",
          });
          pane = structured<{ pane: { dead: boolean } }>(answer).pane;
          if (!pane.dead) {
            // eslint-disable-next-line no-await-in-loop -- bounded polling waits before re-reading.
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(pane.dead).toBe(true);

        // The whole timeout used to be spent here waiting for a marker that
        // cannot be printed, and the result then claimed the command was
        // still running. A dead pane reports the command it last ran, so the
        // shell check passed it through.
        const started = Date.now();
        const refused = await client.callTool({
          arguments: {
            command: "echo hi",
            paneId: made.paneId,
            timeoutMs: 8_000,
          },
          name: "run_command",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("respawn_pane");
        expect(Date.now() - started).toBeLessThan(4_000);
      });
    });
  }, 60_000);

  test("reports a command that outran the buffer as finished", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // Past the tail's byte limit, so the start marker is evicted before
        // the end marker arrives. The command still finished; only the
        // evidence of where its output began is gone.
        const result = structured<{
          exitStatus: number | null;
          missedBytes: number;
          outcome: string;
          outputComplete: boolean;
        }>(
          await client.callTool({
            arguments: {
              command:
                "i=0; while [ $i -lt 12000 ]; do echo 0123456789012345678901234567890; " +
                "i=$((i+1)); done; exit 3",
              maxLines: 5,
              paneId,
              timeoutMs: 40_000,
            },
            name: "run_command",
          }),
        );
        expect(result.outcome).toBe("completed");
        expect(result.exitStatus).toBe(3);
        expect(result.outputComplete).toBe(false);
        // And the output is short of what the command printed, which the
        // caller is told rather than left to infer.
        expect(result.missedBytes).toBeGreaterThan(0);
      });
    });
  }, 120_000);

  test("marks a truncated capture fallback as incomplete", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const paneId = await shellPaneId(client);
          const result = structured<{
            missedBytes: number;
            outcome: string;
            outputComplete: boolean;
          }>(
            await client.callTool({
              arguments: {
                command: "i=0; while [ $i -lt 700 ]; do echo line-$i; i=$((i+1)); done",
                maxLines: 5,
                paneId,
                timeoutMs: 20_000,
              },
              name: "run_command",
            }),
          );

          expect(result.outcome).toBe("completed");
          expect(result.missedBytes).toBe(0);
          expect(result.outputComplete).toBe(false);
        },
        { LIBTMUX_MCP_LIVE: "0" },
      );
    });
  }, 60_000);

  test("returns one pane per window even when the names repeat", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const built = structured<{ panes: { id: string; windowId: string }[] }>(
          await client.callTool({
            arguments: {
              session: "dup",
              windows: [{ name: "same" }, { name: "same" }, { name: "same" }],
            },
            name: "build_workspace",
          }),
        );
        expect(built.panes).toHaveLength(3);
        // tmux does not require a window name to be unique, and matching by
        // name resolved all three to the first window — so the caller was
        // handed one pane three times and invited to skip list_panes.
        expect(new Set(built.panes.map((pane) => pane.id)).size).toBe(3);
        expect(new Set(built.panes.map((pane) => pane.windowId)).size).toBe(3);
      });
    });
  }, 60_000);

  test("needs a target for a scope that has one", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        // "" is a legal tmux session name, so using it as the absent-target
        // sentinel meant an untargeted call looked up a session that can
        // exist — and wrote to it.
        const refused = await client.callTool({
          arguments: {
            name: "@probe",
            scope: "session",
            value: "went-somewhere",
          },
          name: "set_option",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("target");

        const reading = await client.callTool({
          arguments: { scope: "session" },
          name: "show_options",
        });
        expect((reading as { isError?: boolean }).isError).toBe(true);
      });
    });
  }, 60_000);

  test("unsets an option so it falls back to what it inherits", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const session = (await serverFor(fixture).snapshot()).sessions.one().name ?? "";
        await client.callTool({
          arguments: {
            name: "@probe",
            scope: "session",
            target: session,
            value: "mine",
          },
          name: "set_option",
        });
        expect(
          structured<{ options: Record<string, string> }>(
            await client.callTool({
              arguments: { scope: "session", target: session },
              name: "show_options",
            }),
          ).options["@probe"],
        ).toBe("mine");

        // Setting is reachable and unsetting was not, so a wrong value was
        // permanent from inside this server.
        await client.callTool({
          arguments: { name: "@probe", scope: "session", target: session },
          name: "unset_option",
        });
        expect(
          structured<{ options: Record<string, string> }>(
            await client.callTool({
              arguments: { scope: "session", target: session },
              name: "show_options",
            }),
          ).options["@probe"],
        ).toBeUndefined();
      });
    });
  }, 60_000);

  test("moves a pane between windows and back out again", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const tmux = serverFor(fixture);
          const session = (await tmux.snapshot()).sessions.one().name ?? "";
          const home = structured<{ paneId: string; window: { id: string } }>(
            await client.callTool({
              arguments: { name: "home", session },
              name: "new_window",
            }),
          );
          const guest = structured<{ paneId: string; window: { id: string } }>(
            await client.callTool({
              arguments: { name: "guest", session },
              name: "new_window",
            }),
          );

          // The one topology operation with no path: a pane could be made,
          // destroyed, and exchanged in place, but not moved into another
          // window. Joining keeps the pane and what runs in it.
          const joined = structured<{ pane: { id: string; windowId: string } }>(
            await client.callTool({
              arguments: { paneId: guest.paneId, windowId: home.window.id },
              name: "move_pane",
            }),
          ).pane;
          expect(joined.id).toBe(guest.paneId);
          expect(joined.windowId).toBe(home.window.id);

          // And back out into a window of its own, by naming no destination.
          const broken = structured<{ pane: { id: string; windowId: string } }>(
            await client.callTool({
              arguments: { paneId: guest.paneId, windowName: "extracted" },
              name: "move_pane",
            }),
          ).pane;
          expect(broken.id).toBe(guest.paneId);
          expect(broken.windowId).not.toBe(home.window.id);
        },
        { LIBTMUX_SAFETY: "destructive" },
      );
    });
  }, 60_000);

  test("reports the socket it is actually driving", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const info = structured<{ socketPath: string | null }>(
          await client.callTool({ arguments: {}, name: "server_info" }),
        );
        const asked = structured<{ value: string }>(
          await client.callTool({
            arguments: { format: "#{socket_path}" },
            name: "display_message",
          }),
        );
        // The two used to be able to disagree: this read the constructor
        // argument while display_message asked tmux. They now have one source.
        //
        // The case that made it null — a server reached on the default socket,
        // where nothing was passed in — cannot be reproduced here, because the
        // suite only ever runs against sockets it owns. This pins the
        // agreement rather than that case.
        expect(info.socketPath).toBe(asked.value);
        expect(info.socketPath).toBe(fixture.socketPath);
      });
    });
  }, 60_000);

  test("says when a pane did not start where it was asked to", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const session = (await serverFor(fixture).snapshot()).sessions.one().name ?? "";
        // tmux chdirs in the forked child and falls back silently, so this
        // succeeds and the pane is somewhere else entirely.
        const made = await client.callTool({
          arguments: {
            name: "elsewhere",
            session,
            startDirectory: "/definitely-not-a-directory-xyz",
          },
          name: "new_window",
        });
        expect((made as { isError?: boolean }).isError ?? false).toBe(false);
        const text = toolText(made);
        expect(text).toContain("was not used");
        expect(text).toContain("/definitely-not-a-directory-xyz");
      });
    });
  }, 60_000);

  test("splits a pane into the directory that pane is in", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { command: "cd /etc", paneId },
          name: "run_command",
        });
        // run_command runs in a subshell, so move the pane itself.
        await client.callTool({
          arguments: { enter: true, keys: "cd /etc", paneId },
          name: "send_keys",
        });
        await new Promise((resolve) => setTimeout(resolve, 700));

        const split = structured<{ pane: { cwd: string } }>(
          await client.callTool({ arguments: { paneId }, name: "split_pane" }),
        ).pane;
        // tmux consults the client and then the session, never the pane being
        // split, so this used to land in the session's directory.
        expect(split.cwd).toBe("/etc");

        // Naming one still wins over the inherited default.
        const named = structured<{ pane: { cwd: string } }>(
          await client.callTool({
            arguments: { paneId, startDirectory: "/tmp" },
            name: "split_pane",
          }),
        ).pane;
        expect(named.cwd).toBe("/tmp");
      });
    });
  }, 60_000);

  test("says when a layout string was accepted and ignored", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const session = (await serverFor(fixture).snapshot()).sessions.one().name ?? "";
        const wide = structured<{ paneId: string; window: { id: string } }>(
          await client.callTool({
            arguments: { name: "wide", session },
            name: "new_window",
          }),
        );
        await client.callTool({
          arguments: { paneId: wide.paneId },
          name: "split_pane",
        });
        const twoPane = structured<{ window: { layout: string } }>(
          await client.callTool({
            arguments: { layout: "even-horizontal", windowId: wide.window.id },
            name: "select_layout",
          }),
        ).window.layout;

        const narrow = structured<{ window: { id: string } }>(
          await client.callTool({
            arguments: { name: "narrow", session },
            name: "new_window",
          }),
        ).window;

        // tmux exits 0 for a layout describing a different set of panes and
        // changes nothing, so the call looks like it worked.
        const ignored = await client.callTool({
          arguments: { layout: twoPane, windowId: narrow.id },
          name: "select_layout",
        });
        expect(toolText(ignored)).toContain("was not applied");

        // The quiet half: a layout that does apply says nothing, or the notice
        // is noise on every call rather than a signal.
        const applied = await client.callTool({
          arguments: { layout: "even-vertical", windowId: wide.window.id },
          name: "select_layout",
        });
        expect(toolText(applied)).not.toContain("was not applied");
      });
    });
  }, 60_000);

  test("lists the hooks that run, and counts the rest", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const shown = structured<{
          hooks: Record<string, string>;
          unset: number;
        }>(await client.callTool({ arguments: {}, name: "show_hooks" }));
        // tmux reports its whole table, nearly all of it empty; the question is
        // which hooks run.
        expect(shown.unset).toBeGreaterThan(0);
        for (const [name, command] of Object.entries(shown.hooks)) {
          expect(command, `${name} was listed with no command`).not.toBe("");
        }
      });
    });
  }, 60_000);

  test("tells a mistyped format from an empty field", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);

        // tmux prints nothing for a name it has never heard of and exits 0, so
        // this used to be the same answer as a field that is genuinely empty.
        const typo = await client.callTool({
          arguments: {
            format: "#{nonexistent_field_xyz}",
            paneId,
            target: paneId,
          },
          name: "display_message",
        });
        expect(toolText(typo)).toContain("nonexistent_field_xyz");

        // The quiet half, twice over. A format that resolves says nothing...
        const resolved = await client.callTool({
          arguments: { format: "#{pane_id}", target: paneId },
          name: "display_message",
        });
        expect(toolText(resolved)).toContain(paneId);
        expect(toolText(resolved)).not.toContain("has no field");

        // ...and a real field that is merely empty is not called a typo.
        const empty = await client.callTool({
          arguments: { format: "#{pane_start_command}", target: paneId },
          name: "display_message",
        });
        expect(toolText(empty)).not.toContain("has no field");

        // An expression is not a name, and rejecting a working format would be
        // worse than the silence this replaces.
        const expression = await client.callTool({
          arguments: { format: "#{?pane_dead,dead,live}", target: paneId },
          name: "display_message",
        });
        expect(toolText(expression)).not.toContain("has no field");

        // A bad name beside a good one resolves to something that reads like a
        // value — "%0-" looks like an answer rather than a mistake — so a
        // result being non-empty is not evidence that all of it resolved.
        const partial = await client.callTool({
          arguments: {
            format: "#{pane_id}-#{nonexistent_field_xyz}",
            target: paneId,
          },
          name: "display_message",
        });
        expect(toolText(partial)).toContain("nonexistent_field_xyz");

        // And the quiet half of that: two names that both resolve say nothing.
        const both = await client.callTool({
          arguments: { format: "#{pane_id}-#{pane_index}", target: paneId },
          name: "display_message",
        });
        expect(toolText(both)).not.toContain("has no field");
      });
    });
  }, 60_000);

  test("reaches the options a session actually inherits", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const session = (await serverFor(fixture).snapshot()).sessions.one().name ?? "";

        // A session that has set nothing reports nothing, and that used to be
        // the whole answer — while the values governing it live in the global
        // scopes, which nothing could reach.
        const own = structured<{ options: Record<string, string> }>(
          await client.callTool({
            arguments: { scope: "session", target: session },
            name: "show_options",
          }),
        ).options;

        const inherited = structured<{ options: Record<string, string> }>(
          await client.callTool({
            arguments: { scope: "global-session" },
            name: "show_options",
          }),
        ).options;
        expect(Object.keys(inherited).length).toBeGreaterThan(Object.keys(own).length);
        // default-shell decides what a new pane runs, and run_command refuses a
        // shell it cannot address; history-limit decides how far capture_pane's
        // negative start reaches. Both are global SESSION options — checked
        // against tmux rather than assumed, since guessing the scope is how a
        // present option reads as missing.
        expect(inherited["default-shell"]).toBeDefined();
        expect(inherited["history-limit"]).toBeDefined();

        // The window table is a different set: remain-on-exit lives there, and
        // is what keeps a pane whose process has exited.
        const windows = structured<{ options: Record<string, string> }>(
          await client.callTool({
            arguments: { scope: "global-window" },
            name: "show_options",
          }),
        ).options;
        expect(windows["remain-on-exit"]).toBeDefined();

        // Writable and undoable at the same scope.
        await client.callTool({
          arguments: {
            name: "@probe",
            scope: "global-session",
            value: "inherited",
          },
          name: "set_option",
        });
        expect(
          structured<{ options: Record<string, string> }>(
            await client.callTool({
              arguments: { scope: "global-session" },
              name: "show_options",
            }),
          ).options["@probe"],
        ).toBe("inherited");
        await client.callTool({
          arguments: { name: "@probe", scope: "global-session" },
          name: "unset_option",
        });
        expect(
          structured<{ options: Record<string, string> }>(
            await client.callTool({
              arguments: { scope: "global-session" },
              name: "show_options",
            }),
          ).options["@probe"],
        ).toBeUndefined();

        // A global scope names no object, so it must not demand a target.
        const noTarget = await client.callTool({
          arguments: { scope: "global-window" },
          name: "show_options",
        });
        expect((noTarget as { isError?: boolean }).isError ?? false).toBe(false);
      });
    });
  }, 60_000);

  test("declares an open world wherever it runs a command", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const byName = new Map(
          (await client.listTools()).tools.map((tool) => [tool.name, tool.annotations]),
        );

        // openWorldHint is one of the signals a host uses to decide what it may
        // approve without asking, and the tier cannot separate these: all of
        // them are legitimately mutating. Every tool taking a shellCommand does
        // whatever that command does, which is as unknowable from here as what
        // send_keys types. set_option can persist the same authority in a
        // format's #() host-shell job.
        for (const name of [
          "send_keys",
          "paste_text",
          "paste_buffer",
          "run_command",
          "new_session",
          "new_window",
          "split_pane",
          "respawn_pane",
          "build_workspace",
          "display_message",
          "pipe_pane",
          "set_option",
        ]) {
          expect(byName.get(name)?.openWorldHint, `${name} hides an open world`).toBe(true);
        }

        // The quiet half: a tool that only rearranges tmux does not claim one,
        // or the hint stops meaning anything.
        for (const name of ["select_pane", "rename_window", "list_panes", "capture_pane"]) {
          expect(byName.get(name)?.openWorldHint, `${name} claims an open world`).not.toBe(true);
        }

        // A spawn creates rather than ends, and a host needs those apart.
        expect(byName.get("new_window")?.destructiveHint).toBe(false);
        expect(byName.get("set_option")?.destructiveHint).toBe(true);
      });
    });
  }, 60_000);
});
