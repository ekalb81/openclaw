import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { lintPluginPolicy } from "./policy-lint.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-policy-lint-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writePluginFixture(params: {
  rootDir: string;
  pluginId: string;
  dependencies?: Record<string, string>;
}) {
  fs.mkdirSync(params.rootDir, { recursive: true });
  fs.writeFileSync(path.join(params.rootDir, "index.ts"), "export default function () {}", "utf-8");
  fs.writeFileSync(
    path.join(params.rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    }),
    "utf-8",
  );
  if (params.dependencies) {
    fs.writeFileSync(
      path.join(params.rootDir, "package.json"),
      JSON.stringify({
        name: params.pluginId,
        version: "1.0.0",
        dependencies: params.dependencies,
      }),
      "utf-8",
    );
  }
}

async function withStateDir<T>(stateDir: string, fn: () => Promise<T>) {
  return await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      CLAWDBOT_STATE_DIR: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
    },
    fn,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("lintPluginPolicy", () => {
  it("errors when auto-discovered workspace plugin is not allowlisted in enforce mode", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "alpha");
    writePluginFixture({
      rootDir: pluginDir,
      pluginId: "alpha",
    });

    const result = await withStateDir(stateDir, async () => {
      return lintPluginPolicy({
        config: {},
        workspaceDir,
        trustMode: "enforce",
      });
    });

    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === "trust_allowlist_missing" &&
          issue.level === "error" &&
          issue.pluginId === "alpha",
      ),
    ).toBe(true);
  });

  it("warns instead of error in warn mode for missing workspace allowlist entry", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "beta");
    writePluginFixture({
      rootDir: pluginDir,
      pluginId: "beta",
    });

    const result = await withStateDir(stateDir, async () => {
      return lintPluginPolicy({
        config: {},
        workspaceDir,
        trustMode: "warn",
      });
    });

    expect(result.ok).toBe(true);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === "trust_allowlist_missing" &&
          issue.level === "warn" &&
          issue.pluginId === "beta",
      ),
    ).toBe(true);
  });

  it("treats explicit lint paths as trusted config origins", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "explicit-plugin");
    writePluginFixture({
      rootDir: pluginDir,
      pluginId: "explicit-plugin",
    });

    const result = await withStateDir(stateDir, async () => {
      return lintPluginPolicy({
        config: {},
        explicitPaths: [pluginDir],
        trustMode: "enforce",
      });
    });

    expect(result.ok).toBe(true);
    expect(result.plugins.some((plugin) => plugin.id === "explicit-plugin")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "trust_allowlist_missing")).toBe(false);
  });

  it("flags workspace protocol and runtime openclaw dependencies", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "deps-plugin");
    writePluginFixture({
      rootDir: pluginDir,
      pluginId: "deps-plugin",
      dependencies: {
        openclaw: "^2026.1.0",
        "@openclaw/example": "workspace:*",
      },
    });

    const result = await withStateDir(stateDir, async () => {
      return lintPluginPolicy({
        config: {},
        explicitPaths: [pluginDir],
        trustMode: "enforce",
      });
    });

    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === "dependency_workspace_protocol" && issue.pluginId === "deps-plugin",
      ),
    ).toBe(true);
    expect(
      result.issues.some(
        (issue) => issue.code === "dependency_openclaw_runtime" && issue.pluginId === "deps-plugin",
      ),
    ).toBe(true);
  });
});
