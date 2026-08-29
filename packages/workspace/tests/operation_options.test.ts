import { describe, expect, test } from "bun:test";

import { Server } from "libtmux/server";
import {
  applyWorkspace,
  planWorkspace,
  type ApplyWorkspaceOptions,
  type PlanWorkspaceOptions,
} from "../src/builder.js";
import { OWNERSHIP_OPTION } from "../src/ownership.js";

const WORKSPACE = { session_name: "validated", windows: [{ panes: [] }] };

function serverThatMustStayUnreached(): {
  readonly invocations: () => number;
  readonly server: Server;
} {
  let count = 0;
  return {
    invocations: () => count,
    server: new Server({
      engine: {
        endpoint: "reject://unreached",
        execute: () => {
          count += 1;
          throw new Error("tmux must not be reached");
        },
      },
    }),
  };
}

describe("workspace operation validation", () => {
  test("reserves ownership before contacting tmux", async () => {
    const { invocations, server } = serverThatMustStayUnreached();
    const workspace = {
      ...WORKSPACE,
      options: { [OWNERSHIP_OPTION]: "forged" },
    };

    await expect(applyWorkspace(server, workspace)).rejects.toThrow(
      `${OWNERSHIP_OPTION} is reserved for workspace ownership`,
    );
    await expect(planWorkspace(server, workspace)).rejects.toThrow(
      `${OWNERSHIP_OPTION} is reserved for workspace ownership`,
    );
    expect(invocations()).toBe(0);
  });

  test("rejects invalid planning options before contacting tmux", async () => {
    const { invocations, server } = serverThatMustStayUnreached();
    const applyOptions = { commands: "always", prune: "owned" } as const;

    await expect(planWorkspace(server, WORKSPACE, applyOptions)).rejects.toThrow(
      "planWorkspace does not plan pane command delivery",
    );
    await expect(
      planWorkspace(server, WORKSPACE, {
        prune: "sometimes",
      } as unknown as PlanWorkspaceOptions),
    ).rejects.toThrow('workspace prune must be "always", "never", or "owned"');
    await expect(
      planWorkspace(server, WORKSPACE, {
        prune: "owned",
        prunes: "never",
      } as unknown as PlanWorkspaceOptions),
    ).rejects.toThrow("planWorkspace does not accept option prunes");
    await expect(
      planWorkspace(server, WORKSPACE, [] as unknown as PlanWorkspaceOptions),
    ).rejects.toThrow("planWorkspace options must be a plain object");
    expect(invocations()).toBe(0);
  });

  test("rejects invalid apply options before contacting tmux", async () => {
    const { invocations, server } = serverThatMustStayUnreached();

    await expect(
      applyWorkspace(server, WORKSPACE, {
        commands: "create-onyl",
      } as unknown as ApplyWorkspaceOptions),
    ).rejects.toThrow('workspace commands must be "always" or "create-only"');
    await expect(
      applyWorkspace(server, WORKSPACE, {
        prune: "sometimes",
      } as unknown as ApplyWorkspaceOptions),
    ).rejects.toThrow('workspace prune must be "always", "never", or "owned"');
    await expect(
      applyWorkspace(server, WORKSPACE, {
        prune: "owned",
        prunes: "never",
      } as unknown as ApplyWorkspaceOptions),
    ).rejects.toThrow("applyWorkspace does not accept option prunes");
    await expect(
      applyWorkspace(server, WORKSPACE, false as unknown as ApplyWorkspaceOptions),
    ).rejects.toThrow("applyWorkspace options must be a plain object");
    expect(invocations()).toBe(0);
  });
});
