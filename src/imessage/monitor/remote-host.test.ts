import { describe, expect, it, vi } from "vitest";
import { detectRemoteHostFromCliPath, resolveIMessageRemoteHost } from "./remote-host.js";

describe("detectRemoteHostFromCliPath", () => {
  it("extracts user@host from ssh wrapper scripts", async () => {
    const readFile = vi.fn(
      async () => 'exec ssh -T openclaw@192.168.64.3 /opt/homebrew/bin/imsg "$@"',
    );
    const remoteHost = await detectRemoteHostFromCliPath("~/bin/imsg-wrap", {
      readFile,
      homeDir: "/Users/openclaw",
    });
    expect(remoteHost).toBe("openclaw@192.168.64.3");
    expect(readFile).toHaveBeenCalledWith("/Users/openclaw/bin/imsg-wrap", "utf8");
  });

  it("extracts host-only aliases from ssh wrapper scripts", async () => {
    const readFile = vi.fn(async () => 'exec ssh -T mac-mini imsg "$@"');
    const remoteHost = await detectRemoteHostFromCliPath("/tmp/imsg-wrap", {
      readFile,
    });
    expect(remoteHost).toBe("mac-mini");
  });

  it("returns undefined when script cannot be read", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("missing");
    });
    const remoteHost = await detectRemoteHostFromCliPath("/tmp/missing", {
      readFile,
    });
    expect(remoteHost).toBeUndefined();
  });
});

describe("resolveIMessageRemoteHost", () => {
  it("uses configured remote host when valid", async () => {
    const readFile = vi.fn(async () => "ignored");
    const remoteHost = await resolveIMessageRemoteHost({
      configuredRemoteHost: "openclaw@mac-mini",
      cliPath: "/tmp/imsg-wrap",
      readFile,
    });
    expect(remoteHost).toBe("openclaw@mac-mini");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back to detected host when configured host is unsafe", async () => {
    const logs: string[] = [];
    const remoteHost = await resolveIMessageRemoteHost({
      configuredRemoteHost: "bad host value",
      cliPath: "/tmp/imsg-wrap",
      readFile: async () => 'exec ssh -T mac-mini imsg "$@"',
      logVerbose: (message) => {
        logs.push(message);
      },
    });
    expect(remoteHost).toBe("mac-mini");
    expect(logs.join("\n")).toContain("ignoring unsafe channels.imessage.remoteHost value");
    expect(logs.join("\n")).toContain("detected remoteHost=mac-mini");
  });

  it("rejects unsafe auto-detected hosts", async () => {
    const logs: string[] = [];
    const remoteHost = await resolveIMessageRemoteHost({
      cliPath: "/tmp/imsg-wrap",
      readFile: async () => 'exec ssh -T openclaw@host:22 imsg "$@"',
      logVerbose: (message) => {
        logs.push(message);
      },
    });
    expect(remoteHost).toBeUndefined();
    expect(logs.join("\n")).toContain("ignoring unsafe auto-detected remoteHost");
  });
});
