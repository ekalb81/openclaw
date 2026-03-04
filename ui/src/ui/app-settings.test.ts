import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveChatReliabilitySettings, setTabFromRoute } from "./app-settings.ts";
import type { Tab } from "./navigation.ts";

type SettingsHost = Parameters<typeof setTabFromRoute>[0] & {
  logsPollInterval: number | null;
  debugPollInterval: number | null;
};

const createHost = (tab: Tab): SettingsHost => ({
  settings: {
    gatewayUrl: "",
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
  theme: "system",
  themeResolved: "dark",
  applySessionKey: "main",
  sessionKey: "main",
  tab,
  connected: false,
  chatHasAutoScrolled: false,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  basePath: "",
  themeMedia: null,
  themeMediaHandler: null,
  logsPollInterval: null,
  debugPollInterval: null,
});

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    if (typeof window === "undefined") {
      vi.stubGlobal("window", globalThis as unknown as Window & typeof globalThis);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts and stops log polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "logs");
    expect(host.logsPollInterval).not.toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.logsPollInterval).toBeNull();
  });

  it("starts and stops debug polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "debug");
    expect(host.debugPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.debugPollInterval).toBeNull();
  });
});

describe("resolveChatReliabilitySettings", () => {
  it("uses defaults when reliability fields are unset", () => {
    const settings = createHost("chat").settings;
    const resolved = resolveChatReliabilitySettings(settings);
    expect(resolved).toEqual({
      autoRecoverOnGap: true,
      gapRecoveryDelayMs: 600,
      runWatchdogEnabled: true,
      runWatchdogMs: 60_000,
    });
  });

  it("applies and clamps reliability overrides", () => {
    const settings = {
      ...createHost("chat").settings,
      chatAutoRecoverOnGap: false,
      chatAutoRecoverGapDelayMs: 99_999,
      chatRunWatchdogEnabled: true,
      chatRunWatchdogMs: 1,
    } as unknown as Parameters<typeof resolveChatReliabilitySettings>[0];
    const resolved = resolveChatReliabilitySettings(settings);
    expect(resolved).toEqual({
      autoRecoverOnGap: false,
      gapRecoveryDelayMs: 10_000,
      runWatchdogEnabled: true,
      runWatchdogMs: 5_000,
    });
  });
});
