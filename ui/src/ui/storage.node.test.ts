import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function ensureRuntimeWindow(): Window & typeof globalThis {
  if (typeof window !== "undefined") {
    return window;
  }
  const runtimeWindow = globalThis as unknown as Window & typeof globalThis;
  vi.stubGlobal("window", runtimeWindow);
  return runtimeWindow;
}

function setTestLocation(href: string) {
  const url = new URL(href);
  if (typeof window !== "undefined" && typeof window.history?.replaceState === "function") {
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    return;
  }
  vi.stubGlobal("location", {
    protocol: url.protocol,
    host: url.host,
    pathname: url.pathname,
  } as Location);
}

describe("loadSettings default gateway URL derivation", () => {
  beforeEach(() => {
    vi.resetModules();
    if (typeof localStorage === "undefined") {
      vi.stubGlobal("localStorage", createStorageMock());
    } else {
      localStorage.clear();
    }
    ensureRuntimeWindow().__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
    if (typeof window !== "undefined") {
      window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
    }
    vi.unstubAllGlobals();
  });

  it("uses configured base path and normalizes trailing slash", async () => {
    setTestLocation("https://gateway.example:8443/ignored/path");
    ensureRuntimeWindow().__OPENCLAW_CONTROL_UI_BASE_PATH__ = " /openclaw/ ";

    const { loadSettings } = await import("./storage.ts");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    expect(loadSettings().gatewayUrl).toBe(`${proto}://${location.host}/openclaw`);
  });

  it("infers base path from nested pathname when configured base path is not set", async () => {
    setTestLocation("http://gateway.example:18789/apps/openclaw/chat");
    ensureRuntimeWindow().__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;

    const { loadSettings } = await import("./storage.ts");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    expect(loadSettings().gatewayUrl).toBe(`${proto}://${location.host}/apps/openclaw`);
  });
});
