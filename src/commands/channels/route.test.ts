import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { __testing, channelsRouteCommand } from "./route.js";

const requireValidConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./shared.js", () => ({
  requireValidConfig: (...args: unknown[]) => requireValidConfigMock(...args),
}));

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    runtime: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
      exit: (code: number) => {
        throw new Error(`exit:${code}`);
      },
    },
  };
}

describe("channelsRouteCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints JSON inspection with matched tier and derived thread session keys", async () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "ops",
          match: { channel: "slack", peer: { kind: "group", id: "C_PARENT" } },
        },
      ],
    };
    requireValidConfigMock.mockResolvedValue(cfg);
    const { runtime, logs } = createRuntime();

    await channelsRouteCommand(
      {
        channel: "slack",
        peerKind: "channel",
        peer: "thread-42",
        parentPeerKind: "channel",
        parentPeer: "C_PARENT",
        role: ["r1,r2", "r3"],
        threadId: "TH-9",
        json: true,
      },
      runtime as never,
    );

    const payload = JSON.parse(logs[0] ?? "{}") as {
      input?: { memberRoleIds?: string[] };
      route?: { matchedBy?: string; sessionKey?: string };
      thread?: { sessionKey?: string; parentSessionKey?: string };
    };
    expect(payload.route?.matchedBy).toBe("binding.peer.parent");
    expect(payload.input?.memberRoleIds).toEqual(["r1", "r2", "r3"]);
    expect(payload.route?.sessionKey).toBe("agent:ops:slack:channel:thread-42");
    expect(payload.thread?.sessionKey).toBe("agent:ops:slack:channel:thread-42:thread:th-9");
    expect(payload.thread?.parentSessionKey).toBe("agent:ops:slack:channel:c_parent");
  });

  it("prints human-readable route diagnostics", async () => {
    requireValidConfigMock.mockResolvedValue({} satisfies OpenClawConfig);
    const { runtime, logs } = createRuntime();

    await channelsRouteCommand(
      {
        channel: "telegram",
        account: "tasks",
        peerKind: "direct",
        peer: "7550356539",
      },
      runtime as never,
    );

    const output = logs.join("\n");
    expect(output).toContain("Route input: telegram/tasks");
    expect(output).toContain("Matched by: default");
    expect(output).toContain("Session key: agent:main:main");
    expect(output).toContain("Main session key: agent:main:main");
  });

  it("fails fast for invalid peer kind", async () => {
    requireValidConfigMock.mockResolvedValue({} satisfies OpenClawConfig);
    const { runtime, errors } = createRuntime();

    await expect(
      channelsRouteCommand(
        {
          channel: "telegram",
          peerKind: "room",
          peer: "123",
        },
        runtime as never,
      ),
    ).rejects.toThrow("exit:1");
    expect(errors.join("\n")).toContain("Invalid peer kind");
  });
});

describe("channels route helpers", () => {
  it("normalizes comma and repeat role values", () => {
    expect(__testing.normalizeRoleList(["r1,r2", " r3 "])).toEqual(["r1", "r2", "r3"]);
  });
});
