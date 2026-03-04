import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelId, type ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";

const hoisted = vi.hoisted(() => {
  const computeBackoff = vi.fn(() => 10);
  const sleepWithAbort = vi.fn((ms: number, abortSignal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
  return { computeBackoff, sleepWithAbort };
});

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: hoisted.computeBackoff,
  sleepWithAbort: hoisted.sleepWithAbort,
}));

type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
};

function createTestPlugin(params?: {
  id?: ChannelId;
  account?: TestAccount;
  isConfigured?: (resolved: TestAccount) => boolean | Promise<boolean>;
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  includeDescribeAccount?: boolean;
}): ChannelPlugin<TestAccount> {
  const id = params?.id ?? "discord";
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => account,
    isEnabled: (resolved) => resolved.enabled !== false,
    ...(params?.isConfigured
      ? {
          isConfigured: (resolved) => params.isConfigured!(resolved),
        }
      : {}),
  };
  if (includeDescribeAccount) {
    config.describeAccount = (resolved) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: resolved.enabled !== false,
      configured: resolved.configured !== false,
    });
  }
  const gateway: NonNullable<ChannelPlugin<TestAccount>["gateway"]> = {};
  if (params?.startAccount) {
    gateway.startAccount = params.startAccount;
  }
  return {
    id,
    meta: {
      id,
      label: id[0].toUpperCase() + id.slice(1),
      selectionLabel: id[0].toUpperCase() + id.slice(1),
      docsPath: `/channels/${id}`,
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway,
  };
}

function installTestRegistry(...plugins: ChannelPlugin<TestAccount>[]) {
  const registry = createEmptyPluginRegistry();
  for (const plugin of plugins) {
    registry.channels.push({
      pluginId: plugin.id,
      source: "test",
      plugin,
    });
  }
  setActivePluginRegistry(registry);
}

function createManager(options?: {
  channelRuntime?: PluginRuntime["channel"];
  config?: OpenClawConfig;
}) {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = {
    discord: log,
    telegram: log.child("telegram"),
    signal: log.child("signal"),
  } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = {
    discord: runtime,
    telegram: runtime,
    signal: runtime,
  } as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    loadConfig: () => options?.config ?? {},
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("server-channels auto restart", () => {
  let previousRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    vi.useFakeTimers();
    hoisted.computeBackoff.mockClear();
    hoisted.sleepWithAbort.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("caps crash-loop restarts after max attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(startAccount).toHaveBeenCalledTimes(11);
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.reconnectAttempts).toBe(10);
    expect(snapshot.restartTelemetry?.discord?.[DEFAULT_ACCOUNT_ID]).toEqual({
      accountId: DEFAULT_ACCOUNT_ID,
      attempts: 10,
      maxAttempts: 10,
      exhausted: true,
      manuallyStopped: false,
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("does not auto-restart after manual stop during backoff", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    vi.runAllTicks();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(1);
    const telemetry = manager.getRuntimeSnapshot().restartTelemetry?.discord?.[DEFAULT_ACCOUNT_ID];
    expect(telemetry).toEqual(
      expect.objectContaining({
        accountId: DEFAULT_ACCOUNT_ID,
        maxAttempts: 10,
        exhausted: false,
        manuallyStopped: true,
      }),
    );
    expect(typeof telemetry?.attempts).toBe("number");
  });

  it("marks enabled/configured when account descriptors omit them", () => {
    installTestRegistry(
      createTestPlugin({
        includeDescribeAccount: false,
      }),
    );
    const manager = createManager();
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.enabled).toBe(true);
    expect(account?.configured).toBe(true);
  });

  it("passes channelRuntime through channel gateway context when provided", async () => {
    const channelRuntime = { marker: "channel-runtime" } as unknown as PluginRuntime["channel"];
    const startAccount = vi.fn(async (ctx) => {
      expect(ctx.channelRuntime).toBe(channelRuntime);
    });

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ channelRuntime });

    await manager.startChannels();
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("starts channels with bounded startup concurrency", async () => {
    const gates = {
      discord: createDeferred<boolean>(),
      telegram: createDeferred<boolean>(),
      signal: createDeferred<boolean>(),
    };
    const inFlight = new Set<ChannelId>();
    let peakConcurrent = 0;

    const makePlugin = (id: "discord" | "telegram" | "signal") =>
      createTestPlugin({
        id,
        isConfigured: async () => {
          inFlight.add(id);
          peakConcurrent = Math.max(peakConcurrent, inFlight.size);
          const result = await gates[id].promise;
          inFlight.delete(id);
          return result;
        },
        startAccount: vi.fn(async () => {}),
      });

    installTestRegistry(makePlugin("discord"), makePlugin("telegram"), makePlugin("signal"));
    const manager = createManager({
      config: {
        gateway: {
          channelStartupConcurrency: 2,
        },
      },
    });

    const startup = manager.startChannels();
    await vi.waitFor(
      () => {
        expect(inFlight.size).toBe(2);
      },
      { timeout: 250, interval: 2 },
    );

    gates.discord.resolve(true);
    await vi.waitFor(
      () => {
        expect(inFlight.has("signal")).toBe(true);
      },
      { timeout: 250, interval: 2 },
    );

    gates.telegram.resolve(true);
    gates.signal.resolve(true);
    await startup;

    expect(peakConcurrent).toBe(2);
  });

  it("continues startup for other channels when one channel fails", async () => {
    const startDiscord = vi.fn(async () => {});
    const startTelegram = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        id: "discord",
        isConfigured: async () => {
          throw new Error("discord bootstrap failed");
        },
        startAccount: startDiscord,
      }),
      createTestPlugin({
        id: "telegram",
        startAccount: startTelegram,
      }),
    );

    const manager = createManager({
      config: {
        gateway: {
          channelStartupConcurrency: 2,
        },
      },
    });

    await expect(manager.startChannels()).rejects.toThrow(/discord bootstrap failed/);
    expect(startDiscord).not.toHaveBeenCalled();
    expect(startTelegram).toHaveBeenCalledTimes(1);
  });
});
