import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { isRecord } from "../utils.js";
import { normalizePluginsConfig } from "./config-state.js";
import { discoverOpenClawPlugins, discoverOpenClawPluginsFromPaths } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginOrigin } from "./types.js";

export type PluginPolicyLintTrustMode = "enforce" | "warn";

export type PluginPolicyLintIssueCode =
  | "plugin_diagnostic"
  | "trust_allowlist_missing"
  | "dependency_workspace_protocol"
  | "dependency_openclaw_runtime";

export type PluginPolicyLintIssue = {
  level: "error" | "warn";
  code: PluginPolicyLintIssueCode;
  message: string;
  pluginId?: string;
  source?: string;
};

export type PluginPolicyLintPlugin = {
  id: string;
  origin: PluginOrigin;
  source: string;
  rootDir: string;
  manifestPath: string;
};

export type PluginPolicyLintResult = {
  ok: boolean;
  trustMode: PluginPolicyLintTrustMode;
  failOnWarn: boolean;
  counts: {
    error: number;
    warn: number;
  };
  plugins: PluginPolicyLintPlugin[];
  issues: PluginPolicyLintIssue[];
};

export type PluginPolicyLintOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  explicitPaths?: string[];
  trustMode?: PluginPolicyLintTrustMode;
  failOnWarn?: boolean;
  env?: NodeJS.ProcessEnv;
};

type PluginPackageLikeManifest = {
  dependencies?: Record<string, unknown>;
};

const readPackageManifest = (rootDir: string): PluginPackageLikeManifest | null => {
  const packagePath = path.join(rootDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return parsed as PluginPackageLikeManifest;
  } catch {
    return null;
  }
};

const normalizeDependencyEntries = (value: unknown): Array<[string, string]> => {
  if (!isRecord(value)) {
    return [];
  }
  const pairs: Array<[string, string]> = [];
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec !== "string") {
      continue;
    }
    const dependencyName = name.trim();
    const dependencySpec = spec.trim();
    if (!dependencyName || !dependencySpec) {
      continue;
    }
    pairs.push([dependencyName, dependencySpec]);
  }
  return pairs;
};

export function resolvePluginPolicyLintTrustMode(
  raw: string | undefined | null,
): PluginPolicyLintTrustMode {
  const value = raw?.trim().toLowerCase();
  return value === "warn" ? "warn" : "enforce";
}

export function lintPluginPolicy(options: PluginPolicyLintOptions = {}): PluginPolicyLintResult {
  const cfg = options.config ?? {};
  const env = options.env ?? process.env;
  const explicitPaths = (options.explicitPaths ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const trustMode =
    options.trustMode ??
    resolvePluginPolicyLintTrustMode(env.OPENCLAW_PLUGIN_POLICY_LINT_TRUST_MODE);
  const failOnWarn =
    options.failOnWarn === true || isTruthyEnvValue(env.OPENCLAW_PLUGIN_POLICY_LINT_FAIL_ON_WARN);
  const normalized = normalizePluginsConfig(cfg.plugins);
  const workspaceDir = options.workspaceDir?.trim();

  const discovery =
    explicitPaths.length > 0
      ? discoverOpenClawPluginsFromPaths({
          paths: explicitPaths,
          workspaceDir,
        })
      : discoverOpenClawPlugins({
          workspaceDir,
          extraPaths: normalized.loadPaths,
        });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir,
    cache: false,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });

  const issues: PluginPolicyLintIssue[] = [];
  for (const diagnostic of manifestRegistry.diagnostics) {
    issues.push({
      level: diagnostic.level === "error" ? "error" : "warn",
      code: "plugin_diagnostic",
      message: diagnostic.message,
      pluginId: diagnostic.pluginId,
      source: diagnostic.source,
    });
  }

  const allowlist = new Set(normalized.allow);
  for (const plugin of manifestRegistry.plugins) {
    const requiresAllowlist = plugin.origin === "workspace" || plugin.origin === "global";
    if (requiresAllowlist && !allowlist.has(plugin.id)) {
      issues.push({
        level: trustMode === "enforce" ? "error" : "warn",
        code: "trust_allowlist_missing",
        pluginId: plugin.id,
        source: plugin.source,
        message: `auto-discovered plugin "${plugin.id}" requires explicit plugins.allow entry`,
      });
    }
  }

  for (const plugin of manifestRegistry.plugins) {
    const pkg = readPackageManifest(plugin.rootDir);
    if (!pkg) {
      continue;
    }
    for (const [dependencyName, dependencySpec] of normalizeDependencyEntries(pkg.dependencies)) {
      if (dependencySpec.toLowerCase().startsWith("workspace:")) {
        issues.push({
          level: "error",
          code: "dependency_workspace_protocol",
          pluginId: plugin.id,
          source: plugin.rootDir,
          message: `runtime dependency "${dependencyName}" uses workspace protocol (${dependencySpec}); publishable plugins must use exact npm-compatible specs`,
        });
      }
      if (dependencyName === "openclaw") {
        issues.push({
          level: "warn",
          code: "dependency_openclaw_runtime",
          pluginId: plugin.id,
          source: plugin.rootDir,
          message:
            'runtime dependency "openclaw" should be moved to devDependencies or peerDependencies',
        });
      }
    }
  }

  const errorCount = issues.filter((entry) => entry.level === "error").length;
  const warnCount = issues.filter((entry) => entry.level === "warn").length;
  const ok = errorCount === 0 && (!failOnWarn || warnCount === 0);

  return {
    ok,
    trustMode,
    failOnWarn,
    counts: {
      error: errorCount,
      warn: warnCount,
    },
    plugins: manifestRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      origin: plugin.origin,
      source: plugin.source,
      rootDir: plugin.rootDir,
      manifestPath: plugin.manifestPath,
    })),
    issues,
  };
}
