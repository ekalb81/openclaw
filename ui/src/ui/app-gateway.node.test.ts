import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "../../../src/gateway/events.js";
import { connectGateway, resolveControlUiClientVersion } from "./app-gateway.ts";

type GatewayHost = Parameters<typeof connectGateway>[0];
type TestGatewayHost = GatewayHost & {
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatMessages: unknown[];
  chatRunWatchdogLastActivityAtMs: number | null;
};

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  options: { clientVersion?: string };
  emitClose: (info: {
    code: number;
    reason?: string;
    error?: { code: string; message: string; details?: unknown };
  }) => void;
  emitGap: (expected: number, received: number) => void;
  emitEvent: (evt: { event: string; payload?: unknown; seq?: number }) => void;
};

const gatewayClientInstances: GatewayClientMock[] = [];

vi.mock("./gateway.ts", () => {
  function resolveGatewayErrorDetailCode(
    error: { details?: unknown } | null | undefined,
  ): string | null {
    const details = error?.details;
    if (!details || typeof details !== "object") {
      return null;
    }
    const code = (details as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  class GatewayBrowserClient {
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly request = vi.fn().mockResolvedValue({ messages: [] });

    constructor(
      private opts: {
        onHello?: (hello: unknown) => void;
        clientVersion?: string;
        onClose?: (info: {
          code: number;
          reason: string;
          error?: { code: string; message: string; details?: unknown };
        }) => void;
        onGap?: (info: { expected: number; received: number }) => void;
        onEvent?: (evt: { event: string; payload?: unknown; seq?: number }) => void;
      },
    ) {
      gatewayClientInstances.push({
        start: this.start,
        stop: this.stop,
        request: this.request,
        options: { clientVersion: this.opts.clientVersion },
        emitClose: (info) => {
          this.opts.onClose?.({
            code: info.code,
            reason: info.reason ?? "",
            error: info.error,
          });
        },
        emitGap: (expected, received) => {
          this.opts.onGap?.({ expected, received });
        },
        emitEvent: (evt) => {
          this.opts.onEvent?.(evt);
        },
      });
    }
  }

  return { GatewayBrowserClient, resolveGatewayErrorDetailCode };
});

function createHost(): TestGatewayHost {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    },
    password: "",
    clientInstanceId: "instance-test",
    client: null,
    connected: false,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    eventLogBuffer: [],
    eventLog: [],
    tab: "overview",
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    agentsLoading: false,
    agentsList: null,
    agentsError: null,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    debugHealth: null,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    sessionKey: "main",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatStream: null,
    chatStreamStartedAt: null,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    compactionStatus: null,
    compactionClearTimer: null,
    fallbackStatus: null,
    fallbackClearTimer: null,
    chatRunId: null,
    chatRunWatchdogLastActivityAtMs: null,
    refreshSessionsAfterChat: new Set<string>(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
  } as TestGatewayHost;
}

describe("connectGateway", () => {
  beforeEach(() => {
    gatewayClientInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores stale client onGap callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitGap(10, 13);
    expect(host.lastError).toBeNull();

    secondClient.emitGap(20, 24);
    expect(host.lastError).toBe(
      "event gap detected (expected seq 20, got 24); refresh recommended",
    );
  });

  it("ignores stale client onEvent callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({ event: "presence", payload: { presence: [{ host: "stale" }] } });
    expect(host.eventLogBuffer).toHaveLength(0);

    secondClient.emitEvent({ event: "presence", payload: { presence: [{ host: "active" }] } });
    expect(host.eventLogBuffer).toHaveLength(1);
    expect(host.eventLogBuffer[0]?.event).toBe("presence");
  });

  it("applies update.available only from active client", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({
      event: GATEWAY_EVENT_UPDATE_AVAILABLE,
      payload: {
        updateAvailable: { currentVersion: "1.0.0", latestVersion: "9.9.9", channel: "latest" },
      },
    });
    expect(host.updateAvailable).toBeNull();

    secondClient.emitEvent({
      event: GATEWAY_EVENT_UPDATE_AVAILABLE,
      payload: {
        updateAvailable: { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "latest" },
      },
    });
    expect(host.updateAvailable).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
  });

  it("ignores stale client onClose callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitClose({ code: 1005 });
    expect(host.lastError).toBeNull();
    expect(host.lastErrorCode).toBeNull();

    secondClient.emitClose({ code: 1005 });
    expect(host.lastError).toBe("disconnected (1005): no reason");
    expect(host.lastErrorCode).toBeNull();
  });

  it("prefers structured connect errors over close reason", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message:
          "unauthorized: gateway token mismatch (open the dashboard URL and paste the token in Control UI settings)",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });

    expect(host.lastError).toContain("gateway token mismatch");
    expect(host.lastErrorCode).toBe("AUTH_TOKEN_MISMATCH");
  });

  it("accepts aliased session keys for chat events", () => {
    const host = createHost();
    host.chatRunId = "run-1";
    host.chatStream = "Working...";
    host.chatStreamStartedAt = 123;

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    host.hello = {
      type: "hello-ok",
      protocol: 3,
      snapshot: {
        sessionDefaults: {
          mainKey: "main",
          mainSessionKey: "agent:main:main",
          defaultAgentId: "main",
        },
      },
    } as unknown as typeof host.hello;

    client.emitEvent({
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: "agent:main:main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
    });

    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatStreamStartedAt).toBeNull();
    expect(host.chatMessages).toHaveLength(1);
    expect(host.settings.lastActiveSessionKey).toBe("main");
  });

  it("auto-recovers after seq gaps using configured delay", async () => {
    vi.useFakeTimers();
    const host = createHost();
    (host.settings as unknown as Record<string, unknown>).chatAutoRecoverOnGap = true;
    (host.settings as unknown as Record<string, unknown>).chatAutoRecoverGapDelayMs = 1_200;
    host.connected = true;
    host.chatRunId = "run-1";
    host.chatStream = "Working...";
    host.chatStreamStartedAt = 5;

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    host.connected = true;

    client.emitGap(11, 15);
    expect(host.lastError).toContain("event gap detected");
    expect(host.chatRunId).toBe("run-1");

    await vi.advanceTimersByTimeAsync(1_199);
    expect(host.chatRunId).toBe("run-1");

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatStreamStartedAt).toBeNull();
    expect(client.request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "main",
      limit: 200,
    });
  });

  it("does not auto-recover after seq gaps when disabled", async () => {
    vi.useFakeTimers();
    const host = createHost();
    (host.settings as unknown as Record<string, unknown>).chatAutoRecoverOnGap = false;
    host.connected = true;
    host.chatRunId = "run-1";
    host.chatStream = "Working...";
    host.chatStreamStartedAt = 5;

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    host.connected = true;

    client.emitGap(3, 9);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(host.chatRunId).toBe("run-1");
    expect(host.chatStream).toBe("Working...");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("touches watchdog activity timestamp on agent events during active run", () => {
    const host = createHost();
    host.chatRunId = "run-1";
    host.chatRunWatchdogLastActivityAtMs = 1;
    host.onboarding = true;

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(12_345);
    client.emitEvent({
      event: "agent",
      payload: {
        runId: "run-1",
        stream: "tool",
        data: { type: "tool.start" },
      },
    });
    expect(host.chatRunWatchdogLastActivityAtMs).toBe(12_345);
    nowSpy.mockRestore();
  });
});

describe("resolveControlUiClientVersion", () => {
  it("returns serverVersion for same-origin websocket targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "ws://localhost:8787",
        serverVersion: "2026.3.3",
        pageUrl: "http://localhost:8787/openclaw/",
      }),
    ).toBe("2026.3.3");
  });

  it("returns serverVersion for same-origin relative targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "/ws",
        serverVersion: "2026.3.3",
        pageUrl: "https://control.example.com/openclaw/",
      }),
    ).toBe("2026.3.3");
  });

  it("returns serverVersion for same-origin http targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "https://control.example.com/ws",
        serverVersion: "2026.3.3",
        pageUrl: "https://control.example.com/openclaw/",
      }),
    ).toBe("2026.3.3");
  });

  it("omits serverVersion for cross-origin targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "wss://gateway.example.com",
        serverVersion: "2026.3.3",
        pageUrl: "https://control.example.com/openclaw/",
      }),
    ).toBeUndefined();
  });
});
